import { randomUUID } from "node:crypto";

/**
 * Process-local registry for extension-loaded agents.
 *
 * This module deliberately knows nothing about Pi hooks, other extensions, timers,
 * or lock state. Runtime wiring binds an attachment once per session lifecycle and
 * passes the returned opaque attachment handle back for busy/idle/detach events.
 * Coverage is limited to same-process attachments that loaded this extension.
 */

export const HUB_SYMBOL = Symbol.for("pi-continue-watchdog:hub:v1");

export interface HubAttachmentIdentity {
	readonly sessionId: string;
	readonly hasUI: boolean;
}

/** Opaque lifecycle handle. Do not construct or persist one outside this process. */
export interface HubAttachment {
	readonly token: string;
	readonly identity: HubAttachmentIdentity;
}

export interface HubMainClaim {
	readonly token: string;
	readonly generation: number;
}

export interface HubMainSnapshot {
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly generation: number;
}

/**
 * A frozen checkpoint for timer/observer wiring. A callback must revalidate its
 * own main claim and compare a relevant revision before acting.
 */
export interface ObservableAgentHubSnapshot {
	readonly revision: number;
	readonly ownershipGeneration: number;
	readonly attachmentCount: number;
	readonly busyCount: number;
	readonly main: HubMainSnapshot | null;
	readonly allObservableIdle: boolean;
}

export type HubEffect =
	| {
			readonly kind: "mainChanged";
			readonly previous: HubMainSnapshot | null;
			readonly main: HubMainSnapshot | null;
	  }
	| { readonly kind: "becameAllObservableIdle" }
	| { readonly kind: "becameObservableBusy" }
	| { readonly kind: "becameNotAllObservableIdle" };

export interface HubTransition {
	readonly applied: boolean;
	readonly snapshot: ObservableAgentHubSnapshot;
	readonly effects: readonly HubEffect[];
}

export interface BindAttachmentInput {
	readonly sessionId: string;
	readonly hasUI: boolean;
	/** An attachment which starts in-flight is busy until its settled lifecycle event. */
	readonly initialBusy?: boolean;
}

export interface BindAttachmentResult {
	readonly created: boolean;
	readonly attachment: HubAttachment;
	/** Present only when this bind won a new or promoted main ownership claim. */
	readonly mainClaim: HubMainClaim | null;
	readonly transition: HubTransition;
}

export interface ObservableAgentHub {
	readonly snapshot: ObservableAgentHubSnapshot;
	bind(input: BindAttachmentInput): BindAttachmentResult;
	markBusy(attachment: HubAttachment): HubTransition;
	markIdle(attachment: HubAttachment): HubTransition;
	detach(attachment: HubAttachment): HubTransition;
	/**
	 * Explicitly elect the deterministic preferred attached candidate after main
	 * release. Existing children are never silently promoted during detach.
	 */
	reclaimMain(attachment: HubAttachment): HubTransition;
	mainClaimFor(attachment: HubAttachment): HubMainClaim | null;
	isCurrentMain(claim: HubMainClaim): boolean;
}

interface RegisteredAttachment {
	readonly attachment: HubAttachment;
	readonly order: number;
	busy: boolean;
}

interface CurrentMain {
	readonly attachment: HubAttachment;
	readonly generation: number;
}

function freezeAttachment(
	sessionId: string,
	hasUI: boolean,
	token: string,
): HubAttachment {
	return Object.freeze({
		token,
		identity: Object.freeze({ sessionId, hasUI }),
	});
}

function freezeClaim(token: string, generation: number): HubMainClaim {
	return Object.freeze({ token, generation });
}

function snapshotMain(main: CurrentMain | undefined): HubMainSnapshot | null {
	if (main === undefined) return null;
	return Object.freeze({
		sessionId: main.attachment.identity.sessionId,
		hasUI: main.attachment.identity.hasUI,
		generation: main.generation,
	});
}

function freezeEffect(effect: HubEffect): HubEffect {
	if (effect.kind !== "mainChanged") return Object.freeze({ ...effect });
	return Object.freeze({
		...effect,
		previous: effect.previous ? Object.freeze({ ...effect.previous }) : null,
		main: effect.main ? Object.freeze({ ...effect.main }) : null,
	});
}

class ProcessObservableAgentHub implements ObservableAgentHub {
	private readonly attachmentsBySessionId = new Map<
		string,
		RegisteredAttachment
	>();
	private readonly attachmentsByToken = new Map<string, RegisteredAttachment>();
	private nextAttachmentOrder = 1;
	private nextOwnershipGeneration = 1;
	private revision = 0;
	private main: CurrentMain | undefined;

	public get snapshot(): ObservableAgentHubSnapshot {
		return this.freezeSnapshot();
	}

	public bind(input: BindAttachmentInput): BindAttachmentResult {
		const existing = this.attachmentsBySessionId.get(input.sessionId);
		if (existing !== undefined) {
			return Object.freeze({
				created: false,
				attachment: existing.attachment,
				mainClaim: null,
				transition: this.noop(),
			});
		}

		const wasAllObservableIdle = this.allObservableIdle();
		const attachment = freezeAttachment(
			input.sessionId,
			input.hasUI,
			randomUUID(),
		);
		const registered: RegisteredAttachment = {
			attachment,
			order: this.nextAttachmentOrder++,
			busy: input.initialBusy === true,
		};
		this.attachmentsBySessionId.set(input.sessionId, registered);
		this.attachmentsByToken.set(attachment.token, registered);

		const effects: HubEffect[] = [];
		let mainClaim: HubMainClaim | null = null;
		if (
			(this.main === undefined && this.attachmentsByToken.size === 1) ||
			(this.main !== undefined &&
				registered.attachment.identity.hasUI &&
				!this.main.attachment.identity.hasUI)
		) {
			mainClaim = this.claimMain(registered, effects);
		}

		return Object.freeze({
			created: true,
			attachment,
			mainClaim,
			transition: this.complete(wasAllObservableIdle, effects),
		});
	}

	public markBusy(attachment: HubAttachment): HubTransition {
		const registered = this.findRegistered(attachment);
		if (registered === undefined || registered.busy) return this.noop();

		const wasAllObservableIdle = this.allObservableIdle();
		registered.busy = true;
		return this.complete(wasAllObservableIdle, []);
	}

	public markIdle(attachment: HubAttachment): HubTransition {
		const registered = this.findRegistered(attachment);
		if (registered === undefined || !registered.busy) return this.noop();

		const wasAllObservableIdle = this.allObservableIdle();
		registered.busy = false;
		return this.complete(wasAllObservableIdle, []);
	}

	public detach(attachment: HubAttachment): HubTransition {
		const registered = this.findRegistered(attachment);
		if (registered === undefined) return this.noop();

		const wasAllObservableIdle = this.allObservableIdle();
		const effects: HubEffect[] = [];
		if (this.main?.attachment === registered.attachment) {
			const previous = snapshotMain(this.main);
			this.main = undefined;
			effects.push({ kind: "mainChanged", previous, main: null });
		}
		this.attachmentsBySessionId.delete(
			registered.attachment.identity.sessionId,
		);
		this.attachmentsByToken.delete(registered.attachment.token);
		return this.complete(wasAllObservableIdle, effects);
	}

	public reclaimMain(attachment: HubAttachment): HubTransition {
		const registered = this.findRegistered(attachment);
		if (registered === undefined || this.main !== undefined) return this.noop();
		if (this.preferredCandidate() !== registered) return this.noop();

		const wasAllObservableIdle = this.allObservableIdle();
		this.claimMain(registered, []);
		const effect: HubEffect = {
			kind: "mainChanged",
			previous: null,
			main: snapshotMain(this.main),
		};
		return this.complete(wasAllObservableIdle, [effect]);
	}

	public mainClaimFor(attachment: HubAttachment): HubMainClaim | null {
		if (this.main?.attachment !== attachment) return null;
		return freezeClaim(attachment.token, this.main.generation);
	}

	public isCurrentMain(claim: HubMainClaim): boolean {
		return (
			this.main?.attachment.token === claim.token &&
			this.main.generation === claim.generation
		);
	}

	private claimMain(
		registered: RegisteredAttachment,
		effects: HubEffect[],
	): HubMainClaim {
		const previous = snapshotMain(this.main);
		const generation = this.nextOwnershipGeneration++;
		this.main = { attachment: registered.attachment, generation };
		effects.push({
			kind: "mainChanged",
			previous,
			main: snapshotMain(this.main),
		});
		return freezeClaim(registered.attachment.token, generation);
	}

	private preferredCandidate(): RegisteredAttachment | undefined {
		let firstUi: RegisteredAttachment | undefined;
		let firstHeadless: RegisteredAttachment | undefined;
		for (const registered of this.attachmentsBySessionId.values()) {
			if (registered.attachment.identity.hasUI) {
				if (firstUi === undefined || registered.order < firstUi.order) {
					firstUi = registered;
				}
			} else if (
				firstHeadless === undefined ||
				registered.order < firstHeadless.order
			) {
				firstHeadless = registered;
			}
		}
		return firstUi ?? firstHeadless;
	}

	private findRegistered(
		attachment: HubAttachment,
	): RegisteredAttachment | undefined {
		const registered = this.attachmentsByToken.get(attachment.token);
		return registered?.attachment === attachment ? registered : undefined;
	}

	private complete(
		wasAllObservableIdle: boolean,
		effects: HubEffect[],
	): HubTransition {
		this.revision += 1;
		const isAllObservableIdle = this.allObservableIdle();
		if (!wasAllObservableIdle && isAllObservableIdle) {
			effects.push({ kind: "becameAllObservableIdle" });
		} else if (wasAllObservableIdle && !isAllObservableIdle) {
			effects.push(
				this.busyCount() > 0
					? { kind: "becameObservableBusy" }
					: { kind: "becameNotAllObservableIdle" },
			);
		}
		return Object.freeze({
			applied: true,
			snapshot: this.freezeSnapshot(),
			effects: Object.freeze(effects.map(freezeEffect)),
		});
	}

	private noop(): HubTransition {
		return Object.freeze({
			applied: false,
			snapshot: this.freezeSnapshot(),
			effects: Object.freeze([]),
		});
	}

	private freezeSnapshot(): ObservableAgentHubSnapshot {
		return Object.freeze({
			revision: this.revision,
			ownershipGeneration: this.nextOwnershipGeneration - 1,
			attachmentCount: this.attachmentsByToken.size,
			busyCount: this.busyCount(),
			main: snapshotMain(this.main),
			allObservableIdle: this.allObservableIdle(),
		});
	}

	private busyCount(): number {
		let count = 0;
		for (const attachment of this.attachmentsByToken.values()) {
			if (attachment.busy) count += 1;
		}
		return count;
	}

	private allObservableIdle(): boolean {
		return this.main !== undefined && this.busyCount() === 0;
	}
}

/** Returns the sole process-local hub shared by every loaded extension attachment. */
export function getProcessObservableAgentHub(): ObservableAgentHub {
	const globalState = globalThis as typeof globalThis & {
		[HUB_SYMBOL]?: ObservableAgentHub;
	};
	globalState[HUB_SYMBOL] ??= new ProcessObservableAgentHub();
	return globalState[HUB_SYMBOL];
}
