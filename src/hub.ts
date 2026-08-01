import { randomUUID } from "node:crypto";

/**
 * Process-local registry for extension-loaded agents.
 *
 * This module deliberately knows nothing about Pi hooks, other extensions, timers,
 * or lock state. Runtime wiring binds an attachment once per session lifecycle and
 * passes the returned opaque attachment handle back for busy/idle/detach events.
 * Coverage is limited to same-process attachments that loaded this extension.
 */

const PROCESS_HUB_KEY = Symbol.for("pi-continue-watchdog:hub:v1");
const PROCESS_HUB_BRAND = Symbol.for("pi-continue-watchdog:hub-brand:v1");
const PROCESS_HUB_VERSION = "pi-continue-watchdog:hub:v1";
const INVALID_PROCESS_HUB_MESSAGE = "Invalid process observable agent hub";

/**
 * Opaque per-runtime-attachment identity. Create one when an extension instance
 * attaches, retain it for that instance's complete lifecycle, and bind only once.
 * It is deliberately distinct from the informational sessionId: simultaneous
 * attachments can legitimately report the same sessionId.
 *
 * The structural marker intentionally works across physical copies of this module.
 * Runtime authority still comes exclusively from WeakMap object identity.
 */
export interface HubAttachmentInstance {
	readonly kind: "pi-continue-watchdog:hub-attachment-instance:v1";
}

/** Creates one opaque identity for a single runtime extension attachment. */
export function createHubAttachmentInstance(): HubAttachmentInstance {
	return Object.freeze({
		kind: "pi-continue-watchdog:hub-attachment-instance:v1",
	} as const);
}

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
	/**
	 * True when a repeated bind supplied different immutable first-bind metadata.
	 * The original attachment and metadata always win; no transition is applied.
	 */
	readonly inputConflict: boolean;
	/** Null only for an invalid hostile or malformed bind input. */
	readonly attachment: HubAttachment | null;
	/** Present only when this bind won a new or promoted main ownership claim. */
	readonly mainClaim: HubMainClaim | null;
	/** A fixed result code that keeps invalid lifecycle input non-throwing. */
	readonly error: "invalidInput" | null;
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

interface CapturedBindAttachmentInput {
	readonly instance: HubAttachmentInstance;
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly initialBusy: boolean;
}

interface RegisteredAttachment {
	readonly attachment: HubAttachment;
	readonly order: number;
	/** Immutable bind input retained to report duplicate metadata conflicts. */
	readonly initialBusy: boolean;
	active: boolean;
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

/**
 * Captures every public bind property once before any registry access. This keeps
 * lifecycle routing deterministic even when callers accidentally pass a Proxy or
 * an object with hostile getters.
 */
function captureBindInput(
	input: BindAttachmentInput,
): CapturedBindAttachmentInput | null {
	try {
		const instance = input.instance;
		const sessionId = input.sessionId;
		const hasUI = input.hasUI;
		const initialBusy = input.initialBusy;
		if (
			typeof instance !== "object" ||
			instance === null ||
			typeof sessionId !== "string" ||
			typeof hasUI !== "boolean" ||
			(initialBusy !== undefined && typeof initialBusy !== "boolean")
		) {
			return null;
		}
		return { instance, sessionId, hasUI, initialBusy: initialBusy === true };
	} catch {
		return null;
	}
}

class ProcessObservableAgentHub implements ObservableAgentHub {
	private readonly attachmentsByInstance = new WeakMap<
		HubAttachmentInstance,
		RegisteredAttachment
	>();
	private readonly attachmentsByToken = new Map<string, RegisteredAttachment>();
	private nextAttachmentOrder = 1;
	private nextOwnershipGeneration = 1;
	private revision = 0;
	private main: CurrentMain | undefined;

	public constructor() {
		Object.defineProperty(this, PROCESS_HUB_BRAND, {
			value: PROCESS_HUB_VERSION,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}

	public get snapshot(): ObservableAgentHubSnapshot {
		return this.freezeSnapshot();
	}

	public bind(input: BindAttachmentInput): BindAttachmentResult {
		const captured = captureBindInput(input);
		if (captured === null) return this.invalidBind();

		const existing = this.attachmentsByInstance.get(captured.instance);
		if (existing !== undefined) {
			return Object.freeze({
				created: false,
				inputConflict: this.inputConflicts(existing, captured),
				attachment: existing.attachment,
				mainClaim: null,
				error: null,
				transition: this.noop(),
			});
		}

		const wasAllObservableIdle = this.allObservableIdle();
		const attachment = freezeAttachment(
			captured.sessionId,
			captured.hasUI,
			randomUUID(),
		);
		const registered: RegisteredAttachment = {
			attachment,
			order: this.nextAttachmentOrder++,
			initialBusy: captured.initialBusy,
			active: true,
			busy: captured.initialBusy,
		};
		this.attachmentsByInstance.set(captured.instance, registered);
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
			inputConflict: false,
			attachment,
			mainClaim,
			error: null,
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
		registered.active = false;
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
		for (const registered of this.attachmentsByToken.values()) {
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

	private inputConflicts(
		existing: RegisteredAttachment,
		input: CapturedBindAttachmentInput,
	): boolean {
		return (
			existing.attachment.identity.sessionId !== input.sessionId ||
			existing.attachment.identity.hasUI !== input.hasUI ||
			existing.initialBusy !== input.initialBusy
		);
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

	private invalidBind(): BindAttachmentResult {
		return Object.freeze({
			created: false,
			inputConflict: false,
			attachment: null,
			mainClaim: null,
			error: "invalidInput",
			transition: this.noop(),
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

/** Creates an isolated hub for tests or other in-process lifecycle boundaries. */
export function createObservableAgentHub(): ObservableAgentHub {
	return new ProcessObservableAgentHub();
}

function invalidProcessHub(): never {
	throw new TypeError(INVALID_PROCESS_HUB_MESSAGE);
}

type OwnDescriptorRead =
	| { readonly kind: "missing" }
	| { readonly kind: "descriptor"; readonly descriptor: PropertyDescriptor }
	| { readonly kind: "failed" };

function safelyGetOwnDescriptor(
	target: object,
	key: PropertyKey,
): OwnDescriptorRead {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		return descriptor === undefined
			? { kind: "missing" }
			: { kind: "descriptor", descriptor };
	} catch {
		return { kind: "failed" };
	}
}

function dataDescriptorValue(
	descriptor: PropertyDescriptor,
): { readonly kind: "value"; readonly value: unknown } | null {
	return Object.hasOwn(descriptor, "value")
		? { kind: "value", value: descriptor.value }
		: null;
}

function hasOwnCallableSurface(
	candidate: object,
	name: keyof Omit<ObservableAgentHub, "snapshot">,
): boolean {
	let current: object | null = candidate;
	while (current !== null) {
		const read = safelyGetOwnDescriptor(current, name);
		if (read.kind === "failed") return false;
		if (read.kind === "descriptor") {
			return typeof dataDescriptorValue(read.descriptor)?.value === "function";
		}
		try {
			current = Object.getPrototypeOf(current);
		} catch {
			return false;
		}
	}
	return false;
}

function isValidProcessHub(
	candidate: unknown,
): candidate is ObservableAgentHub {
	if (typeof candidate !== "object" || candidate === null) return false;
	const brand = safelyGetOwnDescriptor(candidate, PROCESS_HUB_BRAND);
	if (brand.kind !== "descriptor") return false;
	const brandValue = dataDescriptorValue(brand.descriptor);
	if (
		brandValue === null ||
		brandValue.value !== PROCESS_HUB_VERSION ||
		brand.descriptor.writable !== false ||
		brand.descriptor.configurable !== false ||
		brand.descriptor.enumerable !== false
	) {
		return false;
	}
	return (
		hasOwnCallableSurface(candidate, "bind") &&
		hasOwnCallableSurface(candidate, "markBusy") &&
		hasOwnCallableSurface(candidate, "markIdle") &&
		hasOwnCallableSurface(candidate, "detach") &&
		hasOwnCallableSurface(candidate, "reclaimMain") &&
		hasOwnCallableSurface(candidate, "mainClaimFor") &&
		hasOwnCallableSurface(candidate, "isCurrentMain")
	);
}

/**
 * Returns the sole hardened process-local hub shared by every loaded extension
 * copy. A pre-existing malformed or accessor-backed global is rejected without
 * invoking it or replacing it.
 */
export function getProcessObservableAgentHub(): ObservableAgentHub {
	const existing = safelyGetOwnDescriptor(globalThis, PROCESS_HUB_KEY);
	if (existing.kind === "failed") return invalidProcessHub();
	if (existing.kind === "missing") {
		const hub = createObservableAgentHub();
		try {
			Object.defineProperty(globalThis, PROCESS_HUB_KEY, {
				value: hub,
				writable: false,
				configurable: false,
				enumerable: false,
			});
			return hub;
		} catch {
			return invalidProcessHub();
		}
	}
	const existingValue = dataDescriptorValue(existing.descriptor);
	if (
		existingValue === null ||
		existing.descriptor.writable !== false ||
		existing.descriptor.configurable !== false ||
		existing.descriptor.enumerable !== false ||
		!isValidProcessHub(existingValue.value)
	) {
		return invalidProcessHub();
	}
	return existingValue.value;
}
