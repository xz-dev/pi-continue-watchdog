/**
 * Process-local registry for extension-loaded agents.
 *
 * Coverage is limited to same-process attachments that loaded this extension.
 * Isolated, out-of-process, or non-extension children are never observed.
 * Runtime wiring binds once per attachment lifecycle and reuses the returned
 * opaque handle for busy/idle/detach. This module knows nothing about Pi hooks,
 * timers, or lock state.
 */

/** Opaque identity for one runtime extension attachment (WeakMap key only). */
export type HubAttachmentInstance = object;

/** Creates one opaque identity for a single runtime extension attachment. */
export function createHubAttachmentInstance(): HubAttachmentInstance {
	return {};
}

export interface HubAttachmentIdentity {
	readonly sessionId: string;
	readonly hasUI: boolean;
}

/** Opaque lifecycle handle. Do not construct or persist one outside this process. */
export interface HubAttachment {
	readonly id: number;
	readonly identity: HubAttachmentIdentity;
}

export interface HubMainClaim {
	readonly attachmentId: number;
	readonly generation: number;
}

export interface HubMainSnapshot {
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly generation: number;
}

/**
 * Checkpoint for timer/observer wiring. A callback must revalidate its own main
 * claim and compare a relevant revision before acting.
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

export type HubTransitionListener = (transition: HubTransition) => void;

export interface BindAttachmentInput {
	/** Stable identity created and retained by one runtime extension attachment. */
	readonly instance: HubAttachmentInstance;
	/** Informational only; it is not a registry or idempotency key. */
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
	/** Subscribe to applied transitions. Returns an idempotent unsubscribe. */
	subscribe(listener: HubTransitionListener): () => void;
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

class ProcessObservableAgentHub implements ObservableAgentHub {
	private readonly attachmentsByInstance = new WeakMap<
		HubAttachmentInstance,
		RegisteredAttachment
	>();
	private readonly attachmentsById = new Map<number, RegisteredAttachment>();
	private readonly listeners = new Set<HubTransitionListener>();
	private nextAttachmentId = 1;
	private nextAttachmentOrder = 1;
	private nextOwnershipGeneration = 1;
	private revision = 0;
	private main: CurrentMain | undefined;

	public get snapshot(): ObservableAgentHubSnapshot {
		return this.snapshotOf();
	}

	public bind(input: BindAttachmentInput): BindAttachmentResult {
		const existing = this.attachmentsByInstance.get(input.instance);
		if (existing !== undefined) {
			return {
				created: false,
				attachment: existing.attachment,
				mainClaim: null,
				transition: this.noop(),
			};
		}

		const initialBusy = input.initialBusy === true;
		const wasAllObservableIdle = this.allObservableIdle();
		const attachment: HubAttachment = {
			id: this.nextAttachmentId++,
			identity: {
				sessionId: input.sessionId,
				hasUI: input.hasUI,
			},
		};
		const registered: RegisteredAttachment = {
			attachment,
			order: this.nextAttachmentOrder++,
			busy: initialBusy,
		};
		this.attachmentsByInstance.set(input.instance, registered);
		this.attachmentsById.set(attachment.id, registered);

		const effects: HubEffect[] = [];
		let mainClaim: HubMainClaim | null = null;
		if (this.shouldElectMain(registered)) {
			mainClaim = this.claimMain(registered, effects);
		}

		return {
			created: true,
			attachment,
			mainClaim,
			transition: this.complete(wasAllObservableIdle, effects),
		};
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
			const previous = this.mainSnapshot(this.main);
			this.main = undefined;
			effects.push({ kind: "mainChanged", previous, main: null });
		}
		this.attachmentsById.delete(registered.attachment.id);
		// Keep the WeakMap tombstone so the same instance cannot resurrect.
		return this.complete(wasAllObservableIdle, effects);
	}

	public reclaimMain(attachment: HubAttachment): HubTransition {
		const registered = this.findRegistered(attachment);
		if (registered === undefined || this.main !== undefined) return this.noop();
		if (this.preferredCandidate() !== registered) return this.noop();

		const wasAllObservableIdle = this.allObservableIdle();
		const effects: HubEffect[] = [];
		this.claimMain(registered, effects);
		return this.complete(wasAllObservableIdle, effects);
	}

	public mainClaimFor(attachment: HubAttachment): HubMainClaim | null {
		if (this.main?.attachment !== attachment) return null;
		return {
			attachmentId: attachment.id,
			generation: this.main.generation,
		};
	}

	public isCurrentMain(claim: HubMainClaim): boolean {
		return (
			this.main?.attachment.id === claim.attachmentId &&
			this.main.generation === claim.generation
		);
	}

	public subscribe(listener: HubTransitionListener): () => void {
		this.listeners.add(listener);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.listeners.delete(listener);
		};
	}

	private shouldElectMain(registered: RegisteredAttachment): boolean {
		if (this.main === undefined) {
			return this.attachmentsById.size === 1;
		}
		return (
			registered.attachment.identity.hasUI &&
			!this.main.attachment.identity.hasUI
		);
	}

	private claimMain(
		registered: RegisteredAttachment,
		effects: HubEffect[],
	): HubMainClaim {
		const previous = this.mainSnapshot(this.main);
		const generation = this.nextOwnershipGeneration++;
		this.main = { attachment: registered.attachment, generation };
		effects.push({
			kind: "mainChanged",
			previous,
			main: this.mainSnapshot(this.main),
		});
		return {
			attachmentId: registered.attachment.id,
			generation,
		};
	}

	private preferredCandidate(): RegisteredAttachment | undefined {
		let firstUi: RegisteredAttachment | undefined;
		let firstHeadless: RegisteredAttachment | undefined;
		for (const registered of this.attachmentsById.values()) {
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
		const registered = this.attachmentsById.get(attachment.id);
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
		const transition: HubTransition = {
			applied: true,
			snapshot: this.snapshotOf(),
			effects: [...effects],
		};
		this.notify(transition);
		return transition;
	}

	private noop(): HubTransition {
		return {
			applied: false,
			snapshot: this.snapshotOf(),
			effects: [],
		};
	}

	private notify(transition: HubTransition): void {
		for (const listener of this.listeners) {
			try {
				listener(transition);
			} catch {
				// One bad listener must not break hub transitions or other listeners.
			}
		}
	}

	private snapshotOf(): ObservableAgentHubSnapshot {
		return {
			revision: this.revision,
			ownershipGeneration: this.nextOwnershipGeneration - 1,
			attachmentCount: this.attachmentsById.size,
			busyCount: this.busyCount(),
			main: this.mainSnapshot(this.main),
			allObservableIdle: this.allObservableIdle(),
		};
	}

	private mainSnapshot(main: CurrentMain | undefined): HubMainSnapshot | null {
		if (main === undefined) return null;
		return {
			sessionId: main.attachment.identity.sessionId,
			hasUI: main.attachment.identity.hasUI,
			generation: main.generation,
		};
	}

	private busyCount(): number {
		let count = 0;
		for (const attachment of this.attachmentsById.values()) {
			if (attachment.busy) count += 1;
		}
		return count;
	}

	private allObservableIdle(): boolean {
		return this.main !== undefined && this.busyCount() === 0;
	}
}

/** Creates an isolated hub for tests or other in-process lifecycle boundaries. */
export function createObservableAgentHub(): ObservableAgentHub {
	return new ProcessObservableAgentHub();
}

/**
 * Returns the process-local hub shared by every activation of this module.
 * Pi caches one package module export across activations; a module-level
 * singleton is enough. Physical copies of this file are not supported.
 */
let processHub: ObservableAgentHub | undefined;

export function getProcessObservableAgentHub(): ObservableAgentHub {
	processHub ??= createObservableAgentHub();
	return processHub;
}
