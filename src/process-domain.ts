import {
	ENV_NAMES,
	isProcessDomainOpenError,
	openProcessDomain,
	type ProcessDomainEvent,
	type ProcessDomainNode,
	type ProcessDomainOpenErrorCode,
} from "pi-extension-utils/process-domain";

export const WATCHDOG_ROOT_PID_ENV = "PI_CONTINUE_WATCHDOG_ROOT_PID";
export const FATAL_EXIT_CODE = 78;

const ACTIVITY_CHANNEL = "pi-continue-watchdog.activity.v2";

/** Identity fence for one exact aggregate child-activity observation. */
export interface DomainFence {
	readonly domainEpoch: string;
	readonly activityGeneration: bigint;
}

/** Root-local projection. No aggregate snapshot is sent across processes. */
export interface DomainSnapshot {
	readonly domainId: string;
	readonly domainEpoch: string;
	readonly activityGeneration: bigint;
	readonly busyParticipants: number;
	readonly allIdle: boolean;
	readonly fence: DomainFence;
}

export type ProcessDomainFatalCode =
	| ProcessDomainOpenErrorCode
	| "DOMAIN_UNRECOVERABLE";

export class ProcessDomainFatalError extends Error {
	readonly isProcessDomainFatalError = true as const;

	constructor(
		readonly code: ProcessDomainFatalCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = "ProcessDomainFatalError";
	}
}

export function isProcessDomainFatalError(
	value: unknown,
): value is ProcessDomainFatalError {
	return (
		value instanceof Error &&
		(value as ProcessDomainFatalError).isProcessDomainFatalError === true
	);
}

export type DomainAttachmentInstance = object;

export interface ProcessDomainCoordinator {
	readonly snapshot: DomainSnapshot;
	readonly isRootProcess: boolean;
	attach(
		instance: DomainAttachmentInstance,
		options: {
			/** Queried at attach and after every client reconnect. */
			readonly getIdle: () => boolean;
			readonly onFatal: (error: Error) => void;
		},
	): Promise<void>;
	/** Publish one live ctx.isIdle() observation. Equal reports remain observable. */
	reportIdle(instance: DomainAttachmentInstance, idle: boolean): Promise<void>;
	confirm(fence: DomainFence): Promise<boolean> | boolean;
	subscribe(
		listener: (snapshot: DomainSnapshot, source: "local" | "domain") => void,
	): () => void;
	detach(instance: DomainAttachmentInstance, idle: boolean): Promise<void>;
}

interface AttachmentRecord {
	idle: boolean;
	readonly getIdle: () => boolean;
	readonly onFatal: (error: Error) => void;
}

/** The complete cross-process watchdog business payload. */
interface ActivityWire {
	readonly agentId: string;
	readonly idle: boolean;
}

export interface ProcessDomainCoordinatorOptions {
	readonly open?: typeof openProcessDomain;
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
}

const EMPTY_SNAPSHOT: DomainSnapshot = {
	domainId: "pending",
	domainEpoch: "pending",
	activityGeneration: 0n,
	busyParticipants: 0,
	allIdle: false,
	fence: { domainEpoch: "pending", activityGeneration: 0n },
};

function parseActivity(value: unknown, senderId: string): ActivityWire | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!keys.includes("agentId") ||
		!keys.includes("idle")
	) {
		return null;
	}
	const wire = value as Partial<ActivityWire>;
	return wire.agentId === senderId && typeof wire.idle === "boolean"
		? { agentId: wire.agentId, idle: wire.idle }
		: null;
}

/**
 * One transport node is shared by every watchdog attachment in this JS realm.
 * Only the authenticated root reduces child reports. Connect is neutral;
 * report, disconnect, and local observations each produce a fresh fence.
 */
export function createProcessDomainCoordinator(
	options: ProcessDomainCoordinatorOptions = {},
): ProcessDomainCoordinator {
	const open = options.open ?? openProcessDomain;
	const env = options.env ?? process.env;
	const pid = options.pid ?? process.pid;
	const attachments = new Map<DomainAttachmentInstance, AttachmentRecord>();
	const listeners = new Set<
		(snapshot: DomainSnapshot, source: "local" | "domain") => void
	>();
	const busyChildIds = new Set<string>();
	let node: ProcessDomainNode | null = null;
	let latest = EMPTY_SNAPSHOT;
	let opening: Promise<void> | null = null;
	let root = false;
	let writeTail = Promise.resolve();
	let lifecycleTail = Promise.resolve();
	let unsubscribeActivity: (() => void) | null = null;
	let unsubscribeEvents: (() => void) | null = null;

	const notify = (source: "local" | "domain"): void => {
		if (node === null || !root) return;
		const busyParticipants = busyChildIds.size;
		const activityGeneration = latest.activityGeneration + 1n;
		const domainEpoch = node.declaration.domainId;
		latest = {
			domainId: node.declaration.domainId,
			domainEpoch,
			activityGeneration,
			busyParticipants,
			allIdle: busyParticipants === 0,
			fence: { domainEpoch, activityGeneration },
		};
		for (const listener of listeners) listener(latest, source);
	};

	const reportFatal = (error: Error): void => {
		for (const record of attachments.values()) {
			try {
				record.onFatal(error);
			} catch {
				// Runtime handling belongs to each attachment's Pi adapter.
			}
		}
	};

	const liveAggregateIdle = (): boolean => {
		for (const record of attachments.values()) {
			if (!record.getIdle()) return false;
		}
		return true;
	};

	const queueWrite = (idle?: boolean): Promise<void> => {
		const write = writeTail
			.catch(() => {})
			.then(async () => {
				if (node === null) return;
				if (root) return;
				const observedIdle = idle ?? liveAggregateIdle();
				await node.send(node.declaration.hostNodeId, ACTIVITY_CHANNEL, {
					agentId: node.nodeId,
					idle: observedIdle,
				} satisfies ActivityWire);
			});
		writeTail = write;
		return write;
	};

	const handleTransportEvent = (event: ProcessDomainEvent): void => {
		if (event.type !== "peer" || node === null) return;
		if (!root) {
			if (
				event.peer.nodeId === node.declaration.hostNodeId &&
				event.peer.status === "online"
			) {
				// Reconnect is transport-only. Publish a newly queried live state next.
				void queueWrite().catch(() => {});
			}
			return;
		}
		if (event.peer.status === "online") return;
		// A disconnected child counts as idle even if it last reported busy.
		busyChildIds.delete(event.peer.nodeId);
		notify("domain");
	};

	const queueLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = lifecycleTail.catch(() => {}).then(operation);
		lifecycleTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};

	const ensureOpen = (): Promise<void> => {
		if (opening !== null) return opening;
		opening = (async () => {
			let opened: ProcessDomainNode;
			try {
				opened = await open({
					env,
					metadata: {
						role: "pi-continue-watchdog",
						pid: String(pid),
					},
					onError: () => {
						// Heartbeat loss and reconnect failures are transport state. The
						// peer event/retry path, not business certainty, owns recovery.
					},
				});
			} catch (error) {
				throw new ProcessDomainFatalError(
					isProcessDomainOpenError(error) ? error.code : "DOMAIN_UNRECOVERABLE",
					"failed to initialize continue-watchdog process transport",
					{ cause: error },
				);
			}
			node = opened;
			root = opened.role === "host";
			if (root) env[WATCHDOG_ROOT_PID_ENV] = String(pid);
			unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
			unsubscribeActivity = opened.subscribe(ACTIVITY_CHANNEL, (message) => {
				if (!root) return;
				const peer = opened
					.peers()
					.find((candidate) => candidate.nodeId === message.senderId);
				if (peer?.status !== "online") return;
				const activity = parseActivity(message.value, message.senderId);
				if (activity === null) return;
				if (activity.idle) busyChildIds.delete(activity.agentId);
				else busyChildIds.add(activity.agentId);
				// Equal reports are significant: each one replaces the 10-second fence.
				notify("domain");
			});
			if (root) notify("domain");
			else await queueWrite();
		})().catch((error: unknown) => {
			opening = null;
			const fatal =
				error instanceof Error
					? error
					: new ProcessDomainFatalError(
							"DOMAIN_UNRECOVERABLE",
							"failed to initialize continue-watchdog process transport",
						);
			reportFatal(fatal);
			throw fatal;
		});
		return opening;
	};

	return {
		get snapshot(): DomainSnapshot {
			return latest;
		},
		get isRootProcess(): boolean {
			return root;
		},
		attach(instance, attachOptions): Promise<void> {
			return queueLifecycle(async () => {
				if (attachments.has(instance)) return;
				const alreadyOpen = node !== null;
				const initialIdle = attachOptions.getIdle();
				attachments.set(instance, {
					idle: initialIdle,
					getIdle: attachOptions.getIdle,
					onFatal: attachOptions.onFatal,
				});
				try {
					await ensureOpen();
					if (alreadyOpen && !root) await queueWrite(liveAggregateIdle());
				} catch (error) {
					attachments.delete(instance);
					if (isProcessDomainFatalError(error)) throw error;
					throw new ProcessDomainFatalError(
						"CONNECTION_UNAVAILABLE",
						"failed to publish initial continue-watchdog activity",
						{ cause: error },
					);
				}
			});
		},
		async reportIdle(instance, idle): Promise<void> {
			const record = attachments.get(instance);
			if (record === undefined) return;
			record.idle = idle;
			await queueWrite(root ? undefined : liveAggregateIdle());
		},
		confirm(fence): boolean {
			return (
				root &&
				busyChildIds.size === 0 &&
				latest.allIdle &&
				latest.fence.domainEpoch === fence.domainEpoch &&
				latest.fence.activityGeneration === fence.activityGeneration
			);
		},
		subscribe(listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		detach(instance, idle): Promise<void> {
			return queueLifecycle(async () => {
				const record = attachments.get(instance);
				if (record === undefined) return;
				record.idle = idle;
				if (!root && node !== null) {
					try {
						await queueWrite(liveAggregateIdle());
					} catch {
						// Intentional disconnect remains authoritative at the root.
					}
				}
				attachments.delete(instance);
				if (attachments.size > 0) {
					if (!root) await queueWrite(liveAggregateIdle());
					return;
				}
				await writeTail.catch(() => {});
				unsubscribeEvents?.();
				unsubscribeActivity?.();
				unsubscribeEvents = null;
				unsubscribeActivity = null;
				const closing = node;
				const wasRoot = root;
				node = null;
				opening = null;
				root = false;
				busyChildIds.clear();
				latest = { ...EMPTY_SNAPSHOT, fence: { ...EMPTY_SNAPSHOT.fence } };
				if (wasRoot && env[WATCHDOG_ROOT_PID_ENV] === String(pid)) {
					delete env[WATCHDOG_ROOT_PID_ENV];
				}
				await closing?.close();
			});
		},
	};
}

const PROCESS_DOMAIN_COORDINATOR = Symbol.for(
	"pi-continue-watchdog:process-domain-coordinator:v3",
);

type CoordinatorHost = typeof globalThis & {
	[PROCESS_DOMAIN_COORDINATOR]?: ProcessDomainCoordinator;
};

export function getProcessDomainCoordinator(): ProcessDomainCoordinator {
	const host = globalThis as CoordinatorHost;
	host[PROCESS_DOMAIN_COORDINATOR] ??= createProcessDomainCoordinator();
	return host[PROCESS_DOMAIN_COORDINATOR];
}

export { ENV_NAMES };
