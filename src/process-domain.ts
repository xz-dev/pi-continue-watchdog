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

const ACTIVITY_CHANNEL = "pi-continue-watchdog.activity.v1";
const SNAPSHOT_CHANNEL = "pi-continue-watchdog.snapshot.v1";

export type ActivityState = "busy" | "idle";

export interface DomainFence {
	readonly domainEpoch: string;
	readonly activityGeneration: bigint;
}

export interface DomainSnapshot {
	readonly domainId: string;
	readonly domainEpoch: string;
	readonly revision: bigint;
	readonly activityGeneration: bigint;
	readonly participants: number;
	readonly busyParticipants: number;
	readonly allIdle: boolean;
	readonly certain: boolean;
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
			readonly initialBusy: boolean;
			readonly onFatal: (error: Error) => void;
		},
	): Promise<void>;
	markBusy(
		instance: DomainAttachmentInstance,
		options?: { readonly internalDecision?: boolean },
	): Promise<void>;
	markIdle(instance: DomainAttachmentInstance): Promise<void>;
	setInternalDecision(
		instance: DomainAttachmentInstance,
		internal: boolean,
	): Promise<void>;
	confirm(fence: DomainFence): Promise<boolean> | boolean;
	subscribe(
		listener: (snapshot: DomainSnapshot, source: "local" | "domain") => void,
	): () => void;
	detach(instance: DomainAttachmentInstance): Promise<void>;
}

interface AttachmentRecord {
	busy: boolean;
	internalDecision: boolean;
	onFatal: (error: Error) => void;
}

interface SnapshotWire {
	readonly domainId: string;
	readonly domainEpoch: string;
	readonly revision: string;
	readonly activityGeneration: string;
	readonly participants: number;
	readonly busyParticipants: number;
	readonly allIdle: boolean;
	readonly certain: boolean;
	readonly activityRevisions: readonly {
		readonly nodeId: string;
		readonly revision: string;
	}[];
}

interface ActivityWire {
	readonly state: ActivityState;
	readonly revision: string;
}

export interface ProcessDomainCoordinatorOptions {
	readonly open?: typeof openProcessDomain;
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
}

const EMPTY_SNAPSHOT: DomainSnapshot = {
	domainId: "pending",
	domainEpoch: "pending",
	revision: 0n,
	activityGeneration: 0n,
	participants: 0,
	busyParticipants: 0,
	allIdle: false,
	certain: false,
	fence: { domainEpoch: "pending", activityGeneration: 0n },
};

function snapshotWire(
	snapshot: DomainSnapshot,
	activityRevisions: ReadonlyMap<string, bigint>,
): SnapshotWire {
	return {
		domainId: snapshot.domainId,
		domainEpoch: snapshot.domainEpoch,
		revision: snapshot.revision.toString(),
		activityGeneration: snapshot.activityGeneration.toString(),
		participants: snapshot.participants,
		busyParticipants: snapshot.busyParticipants,
		allIdle: snapshot.allIdle,
		certain: snapshot.certain,
		activityRevisions: Array.from(activityRevisions, ([nodeId, revision]) => ({
			nodeId,
			revision: revision.toString(),
		})),
	};
}

function parseSnapshotWire(value: unknown): {
	snapshot: DomainSnapshot;
	activityRevisions: ReadonlyMap<string, bigint>;
} | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<SnapshotWire>;
	if (
		typeof wire.domainId !== "string" ||
		typeof wire.domainEpoch !== "string" ||
		typeof wire.revision !== "string" ||
		!/^\d+$/.test(wire.revision) ||
		typeof wire.activityGeneration !== "string" ||
		!/^\d+$/.test(wire.activityGeneration) ||
		!Number.isSafeInteger(wire.participants) ||
		Number(wire.participants) < 0 ||
		!Number.isSafeInteger(wire.busyParticipants) ||
		Number(wire.busyParticipants) < 0 ||
		Number(wire.busyParticipants) > Number(wire.participants) ||
		typeof wire.allIdle !== "boolean" ||
		typeof wire.certain !== "boolean" ||
		!Array.isArray(wire.activityRevisions)
	) {
		return null;
	}
	const activityRevisions = new Map<string, bigint>();
	for (const entry of wire.activityRevisions) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as { nodeId?: unknown }).nodeId !== "string" ||
			(entry as { nodeId: string }).nodeId.length === 0 ||
			activityRevisions.has((entry as { nodeId: string }).nodeId) ||
			typeof (entry as { revision?: unknown }).revision !== "string" ||
			!/^[1-9]\d*$/.test((entry as { revision: string }).revision)
		) {
			return null;
		}
		activityRevisions.set(
			(entry as { nodeId: string }).nodeId,
			BigInt((entry as { revision: string }).revision),
		);
	}
	const activityGeneration = BigInt(wire.activityGeneration);
	return {
		snapshot: {
			domainId: wire.domainId,
			domainEpoch: wire.domainEpoch,
			revision: BigInt(wire.revision),
			activityGeneration,
			participants: Number(wire.participants),
			busyParticipants: Number(wire.busyParticipants),
			allIdle: wire.allIdle,
			certain: wire.certain,
			fence: { domainEpoch: wire.domainEpoch, activityGeneration },
		},
		activityRevisions,
	};
}

function parseActivity(
	value: unknown,
): { state: ActivityState; revision: bigint } | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<ActivityWire>;
	if (
		(wire.state !== "busy" && wire.state !== "idle") ||
		typeof wire.revision !== "string" ||
		!/^[1-9]\d*$/.test(wire.revision)
	) {
		return null;
	}
	return { state: wire.state, revision: BigInt(wire.revision) };
}

/**
 * One transport node is shared by every watchdog attachment in this JS realm.
 * The watchdog owns aggregate activity generations; pi-extension-utils only
 * delivers lifecycle facts and peer liveness.
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
	const remoteActivity = new Map<string, ActivityState>();
	const remoteActivityRevisions = new Map<string, bigint>();
	const uncertainPeers = new Set<string>();
	let localActivityRevision = 0n;
	let requiredSnapshotActivityRevision = 0n;
	let acceptedHostSnapshotRevision = 0n;
	let acceptedHostDomainEpoch: string | null = null;
	let node: ProcessDomainNode | null = null;
	let latest = EMPTY_SNAPSHOT;
	let opening: Promise<void> | null = null;
	let root = false;
	let writeTail = Promise.resolve();
	let lifecycleTail = Promise.resolve();
	let unsubscribeActivity: (() => void) | null = null;
	let unsubscribeSnapshots: (() => void) | null = null;
	let unsubscribeEvents: (() => void) | null = null;

	const desiredActivity = (): ActivityState => {
		for (const record of attachments.values()) {
			if (record.busy && !record.internalDecision) return "busy";
		}
		return "idle";
	};

	const notify = (
		snapshot: DomainSnapshot,
		source: "local" | "domain",
	): void => {
		if (
			latest.domainEpoch === snapshot.domainEpoch &&
			latest.revision === snapshot.revision &&
			latest.activityGeneration === snapshot.activityGeneration &&
			latest.participants === snapshot.participants &&
			latest.busyParticipants === snapshot.busyParticipants &&
			latest.allIdle === snapshot.allIdle &&
			latest.certain === snapshot.certain
		) {
			return;
		}
		latest = snapshot;
		for (const listener of listeners) listener(snapshot, source);
	};

	const hostSnapshot = (): DomainSnapshot => {
		if (node === null) return EMPTY_SNAPSHOT;
		let busyParticipants = desiredActivity() === "busy" ? 1 : 0;
		for (const state of remoteActivity.values()) {
			if (state === "busy") busyParticipants += 1;
		}
		const participants = 1 + remoteActivity.size;
		const allIdle = busyParticipants === 0;
		const domainEpoch = node.declaration.domainId;
		const certain = uncertainPeers.size === 0;
		const factsChanged =
			latest.domainEpoch !== domainEpoch ||
			latest.participants !== participants ||
			latest.busyParticipants !== busyParticipants ||
			latest.allIdle !== (certain && allIdle) ||
			latest.certain !== certain;
		const activityGeneration =
			latest.activityGeneration + (factsChanged ? 1n : 0n);
		return {
			domainId: node.declaration.domainId,
			domainEpoch,
			revision: latest.revision + 1n,
			activityGeneration,
			participants,
			busyParticipants,
			allIdle: certain && allIdle,
			certain,
			fence: { domainEpoch, activityGeneration },
		};
	};

	const markClientUncertain = (): void => {
		if (root || node === null || !latest.certain) return;
		const activityGeneration = latest.activityGeneration + 1n;
		notify(
			{
				...latest,
				revision: latest.revision + 1n,
				activityGeneration,
				allIdle: false,
				certain: false,
				fence: { domainEpoch: latest.domainEpoch, activityGeneration },
			},
			"domain",
		);
	};

	const markTransportUncertain = (): void => {
		if (node === null) return;
		if (!root) {
			markClientUncertain();
			return;
		}
		let changed = false;
		for (const peer of node.peers()) {
			if (
				peer.status === "offline" &&
				remoteActivity.has(peer.nodeId) &&
				!uncertainPeers.has(peer.nodeId)
			) {
				uncertainPeers.add(peer.nodeId);
				changed = true;
			}
		}
		if (changed) notify(hostSnapshot(), "domain");
	};

	const reportFatal = (error: Error): void => {
		markTransportUncertain();
		for (const record of attachments.values()) {
			try {
				record.onFatal(error);
			} catch {
				// Runtime handling belongs to each attachment's Pi adapter.
			}
		}
	};

	const publishHostSnapshot = async (
		source: "local" | "domain",
	): Promise<void> => {
		if (!root || node === null) return;
		const snapshot = hostSnapshot();
		notify(snapshot, source);
		await node.broadcast(
			SNAPSHOT_CHANNEL,
			snapshotWire(snapshot, remoteActivityRevisions),
		);
	};

	const handleTransportEvent = (event: ProcessDomainEvent): void => {
		if (event.type !== "peer") return;
		if (!root) {
			if (event.peer.nodeId !== node?.declaration.hostNodeId) return;
			if (event.peer.status === "offline") markClientUncertain();
			else void queueWrite().catch(() => {});
			return;
		}
		if (event.peer.status === "online") {
			if (remoteActivity.has(event.peer.nodeId)) return;
			const initial = event.peer.metadata.activity;
			remoteActivity.set(
				event.peer.nodeId,
				initial === "busy" ? "busy" : "idle",
			);
			uncertainPeers.add(event.peer.nodeId);
		} else {
			if (!remoteActivity.has(event.peer.nodeId)) return;
			uncertainPeers.add(event.peer.nodeId);
		}
		void publishHostSnapshot("domain").catch(reportFatal);
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
						activity: desiredActivity(),
					},
					onError: reportFatal,
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
			const initialClientWrite = root ? null : queueWrite();
			unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
			unsubscribeActivity = opened.subscribe(ACTIVITY_CHANNEL, (message) => {
				if (!root) return;
				const peer = opened
					.peers()
					.find((candidate) => candidate.nodeId === message.senderId);
				if (peer?.status !== "online") return;
				const activity = parseActivity(message.value);
				if (
					activity === null ||
					activity.revision <=
						(remoteActivityRevisions.get(message.senderId) ?? 0n)
				) {
					return;
				}
				uncertainPeers.delete(message.senderId);
				remoteActivity.set(message.senderId, activity.state);
				remoteActivityRevisions.set(message.senderId, activity.revision);
				void publishHostSnapshot("domain").catch(reportFatal);
			});
			unsubscribeSnapshots = opened.subscribe(SNAPSHOT_CHANNEL, (message) => {
				if (root || message.senderId !== opened.declaration.hostNodeId) return;
				const host = opened
					.peers()
					.find((peer) => peer.nodeId === opened.declaration.hostNodeId);
				if (host?.status !== "online") return;
				const parsed = parseSnapshotWire(message.value);
				if (
					parsed === null ||
					parsed.snapshot.domainId !== opened.declaration.domainId ||
					parsed.snapshot.domainEpoch !== opened.declaration.domainId ||
					(acceptedHostDomainEpoch !== null &&
						parsed.snapshot.domainEpoch !== acceptedHostDomainEpoch) ||
					parsed.snapshot.revision <= acceptedHostSnapshotRevision ||
					(parsed.activityRevisions.get(opened.nodeId) ?? 0n) <
						requiredSnapshotActivityRevision
				) {
					return;
				}
				acceptedHostDomainEpoch = parsed.snapshot.domainEpoch;
				acceptedHostSnapshotRevision = parsed.snapshot.revision;
				notify(parsed.snapshot, "domain");
			});
			if (root) await publishHostSnapshot("domain");
			else await initialClientWrite;
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

	const queueWrite = (): Promise<void> => {
		const clientWrite =
			node !== null && !root
				? {
						revision: ++localActivityRevision,
						state: desiredActivity(),
					}
				: null;
		if (clientWrite !== null) {
			requiredSnapshotActivityRevision = clientWrite.revision;
			markClientUncertain();
		}
		const write = writeTail
			.catch(() => {})
			.then(async () => {
				if (node === null) return;
				try {
					if (root) await publishHostSnapshot("local");
					else if (clientWrite !== null) {
						await node.send(node.declaration.hostNodeId, ACTIVITY_CHANNEL, {
							state: clientWrite.state,
							revision: clientWrite.revision.toString(),
						} satisfies ActivityWire);
					}
				} catch (error) {
					reportFatal(
						error instanceof Error
							? error
							: new Error("process transport write failed"),
					);
					throw error;
				}
			});
		writeTail = write;
		return write;
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
				attachments.set(instance, {
					busy: attachOptions.initialBusy,
					internalDecision: false,
					onFatal: attachOptions.onFatal,
				});
				try {
					await ensureOpen();
					if (alreadyOpen) await queueWrite();
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
		async markBusy(instance, markOptions): Promise<void> {
			const record = attachments.get(instance);
			if (record === undefined) return;
			record.busy = true;
			record.internalDecision = markOptions?.internalDecision === true;
			await queueWrite();
		},
		async markIdle(instance): Promise<void> {
			const record = attachments.get(instance);
			if (record === undefined) return;
			record.busy = false;
			record.internalDecision = false;
			await queueWrite();
		},
		async setInternalDecision(instance, internal): Promise<void> {
			const record = attachments.get(instance);
			if (record === undefined) return;
			record.internalDecision = internal && record.busy;
			await queueWrite();
		},
		confirm(fence): boolean {
			return (
				root &&
				latest.certain &&
				latest.allIdle &&
				latest.fence.domainEpoch === fence.domainEpoch &&
				latest.fence.activityGeneration === fence.activityGeneration
			);
		},
		subscribe(listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		detach(instance): Promise<void> {
			return queueLifecycle(async () => {
				if (!attachments.delete(instance)) return;
				if (attachments.size > 0) {
					await queueWrite();
					return;
				}
				await writeTail.catch(() => {});
				unsubscribeEvents?.();
				unsubscribeActivity?.();
				unsubscribeSnapshots?.();
				unsubscribeEvents = null;
				unsubscribeActivity = null;
				unsubscribeSnapshots = null;
				const closing = node;
				const wasRoot = root;
				node = null;
				opening = null;
				root = false;
				remoteActivity.clear();
				remoteActivityRevisions.clear();
				uncertainPeers.clear();
				localActivityRevision = 0n;
				requiredSnapshotActivityRevision = 0n;
				acceptedHostSnapshotRevision = 0n;
				acceptedHostDomainEpoch = null;
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
	"pi-continue-watchdog:process-domain-coordinator:v2",
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
