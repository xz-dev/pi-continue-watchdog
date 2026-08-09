import {
	type DomainFence,
	type DomainSnapshot,
	ENV_NAMES,
	openDomain,
	type ProcessDomain,
	ProcessDomainFatalError,
} from "pi-process-domain";

export const WATCHDOG_ROOT_PID_ENV = "PI_CONTINUE_WATCHDOG_ROOT_PID";

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

export interface ProcessDomainCoordinatorOptions {
	readonly open?: typeof openDomain;
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
}

const EMPTY_SNAPSHOT: DomainSnapshot = {
	domainId: "pending",
	brokerEpoch: "pending",
	revision: 0n,
	activityGeneration: 0n,
	participants: 0,
	busyParticipants: 0,
	pendingSpawns: 0,
	allIdle: false,
	certain: false,
	fence: { brokerEpoch: "pending", activityGeneration: 0n },
};

function hasDomainDeclaration(env: NodeJS.ProcessEnv): boolean {
	return (
		env[ENV_NAMES.DOMAIN_ID] !== undefined ||
		env[ENV_NAMES.DOMAIN_KEY] !== undefined ||
		env[ENV_NAMES.PROTOCOL] !== undefined ||
		env[ENV_NAMES.RESERVATION] !== undefined
	);
}

function exactPid(value: string | undefined): number | null {
	if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * One OS-process participant, shared by every watchdog attachment in this JS
 * realm. Exact attachment records are reduced to one broker busy/idle value.
 */
export function createProcessDomainCoordinator(
	options: ProcessDomainCoordinatorOptions = {},
): ProcessDomainCoordinator {
	const open = options.open ?? openDomain;
	const env = options.env ?? process.env;
	const pid = options.pid ?? process.pid;
	const attachments = new Map<DomainAttachmentInstance, AttachmentRecord>();
	const listeners = new Set<
		(snapshot: DomainSnapshot, source: "local" | "domain") => void
	>();
	let handle: ProcessDomain | null = null;
	let latest = EMPTY_SNAPSHOT;
	let opening: Promise<void> | null = null;
	let unsubscribeDomain: (() => void) | null = null;
	let root = false;
	let writeTail = Promise.resolve();
	let lifecycleTail = Promise.resolve();
	let lastWritten: "busy" | "idle" | null = null;
	let localWriteInFlight = false;

	const notify = (
		snapshot: DomainSnapshot,
		source: "local" | "domain",
	): void => {
		if (
			latest.brokerEpoch === snapshot.brokerEpoch &&
			latest.revision === snapshot.revision
		) {
			return;
		}
		latest = snapshot;
		for (const listener of listeners) listener(snapshot, source);
	};

	const reportFatal = (error: Error): void => {
		for (const record of attachments.values()) {
			try {
				record.onFatal(error);
			} catch {
				// Fatal termination is owned by each attachment's runtime adapter.
			}
		}
	};

	const desiredActivity = (): "busy" | "idle" => {
		for (const record of attachments.values()) {
			if (record.busy && !record.internalDecision) return "busy";
		}
		return "idle";
	};

	const queueWrite = (): Promise<void> => {
		// A rejected runtime write must not poison the serialization tail forever.
		// The caller still observes this operation's failure, while later writes can
		// proceed after the domain client has recovered its participant lease.
		const write = writeTail
			.catch(() => {})
			.then(async () => {
				if (handle === null) return;
				const desired = desiredActivity();
				if (desired === lastWritten) return;
				localWriteInFlight = true;
				try {
					notify(await handle.setActivity(desired), "local");
					lastWritten = desired;
				} catch (error) {
					lastWritten = null;
					throw error;
				} finally {
					localWriteInFlight = false;
				}
			});
		writeTail = write;
		return write;
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
			const declared = hasDomainDeclaration(env);
			const marker = env[WATCHDOG_ROOT_PID_ENV];
			if (
				(!declared && marker !== undefined) ||
				(declared && marker !== undefined && exactPid(marker) === null)
			) {
				throw new ProcessDomainFatalError(
					"INVALID_DECLARATION",
					"watchdog root role does not match the process-domain declaration",
				);
			}
			const result = await open({
				initialActivity: desiredActivity(),
				metadata: { role: "pi-continue-watchdog", pid: String(pid) },
				onFatal: reportFatal,
			});
			handle = result.domain;
			lastWritten = desiredActivity();
			if (result.created) {
				if (declared || marker !== undefined) {
					await handle.close();
					handle = null;
					throw new ProcessDomainFatalError(
						"INVALID_DECLARATION",
						"watchdog root role is inconsistent with domain creation",
					);
				}
				env[WATCHDOG_ROOT_PID_ENV] = String(pid);
				root = true;
			} else {
				// A declared domain without watchdog root metadata is observer-only.
				// The marker is created only together with a brand-new declaration.
				root = exactPid(marker) === pid;
			}
			notify(handle.snapshot(), "domain");
			unsubscribeDomain = handle.subscribe((snapshot) =>
				notify(snapshot, localWriteInFlight ? "local" : "domain"),
			);
		})().catch((error: unknown) => {
			const fatal =
				error instanceof Error
					? error
					: new ProcessDomainFatalError(
							"INVALID_DECLARATION",
							"failed to initialize watchdog process domain",
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
				if (!attachments.has(instance)) {
					attachments.set(instance, {
						busy: attachOptions.initialBusy,
						internalDecision: false,
						onFatal: attachOptions.onFatal,
					});
				}
				await ensureOpen();
				await queueWrite();
				if (handle === null) {
					throw new ProcessDomainFatalError(
						"BROKER_UNAVAILABLE",
						"watchdog process domain closed during attachment",
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
		confirm: (fence) => handle?.confirm(fence) ?? false,
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
				// The caller that queued a failed activity write already observed its
				// error. Final teardown must still settle that write before releasing
				// the participant; close failures below remain observable.
				await writeTail.catch(() => {});
				unsubscribeDomain?.();
				unsubscribeDomain = null;
				const closing = handle;
				const wasRoot = root;
				handle = null;
				opening = null;
				root = false;
				if (wasRoot && exactPid(env[WATCHDOG_ROOT_PID_ENV]) === pid) {
					delete env[WATCHDOG_ROOT_PID_ENV];
				}
				lastWritten = null;
				latest = { ...EMPTY_SNAPSHOT, fence: { ...EMPTY_SNAPSHOT.fence } };
				if (closing !== null) await closing.close();
			});
		},
	};
}

const PROCESS_DOMAIN_COORDINATOR = Symbol.for(
	"pi-continue-watchdog:process-domain-coordinator:v1",
);

type CoordinatorHost = typeof globalThis & {
	[PROCESS_DOMAIN_COORDINATOR]?: ProcessDomainCoordinator;
};

export function getProcessDomainCoordinator(): ProcessDomainCoordinator {
	const host = globalThis as CoordinatorHost;
	host[PROCESS_DOMAIN_COORDINATOR] ??= createProcessDomainCoordinator();
	return host[PROCESS_DOMAIN_COORDINATOR];
}
