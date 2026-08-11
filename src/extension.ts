import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerMainAbortUnlock } from "./abort-outcome.js";
import { registerMainUserAutoLock } from "./auto-lock.js";
import { createMainCommands } from "./commands.js";
import type { ContinueWatchdogConfig } from "./config.js";
import type {
	LoadedConfig,
	LoadRuntimeConfigOptions,
} from "./config-loader.js";
import { registerDecisionContextFolding } from "./context-fold.js";
import type { LockDecisionController } from "./controller.js";
import { createFatalExitAdapter, type FatalExitAdapter } from "./fatal-exit.js";
import {
	createHubAttachmentInstance,
	getProcessObservableAgentHub,
	type ObservableAgentHub,
} from "./hub.js";
import {
	getProcessDomainCoordinator,
	type ProcessDomainCoordinator,
} from "./process-domain.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeControllerHolder,
} from "./runtime.js";

/** Dependencies supplied only by focused lifecycle tests. */
export interface ContinueWatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly fatalExit?: FatalExitAdapter;
	/** Optional lifecycle-test controller; normal installs load effective config. */
	readonly controller?: LockDecisionController;
	readonly config?: ContinueWatchdogConfig;
	readonly clock?: RuntimeClock;
	readonly createExchangeId?: () => string;
	readonly loadConfig?: (
		options: LoadRuntimeConfigOptions,
	) => Promise<LoadedConfig>;
	readonly agentDir?: string;
}

/** Register one attachment's public Pi lifecycle wiring. */
export function createContinueWatchdogExtension(
	options: ContinueWatchdogExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const hub = options.hub ?? getProcessObservableAgentHub();
	const useProductionDomain =
		options.processDomain !== undefined ||
		(options.hub === undefined && options.controller === undefined);
	const processDomain = useProductionDomain
		? (options.processDomain ?? getProcessDomainCoordinator())
		: undefined;
	const fatalExit = useProductionDomain
		? (options.fatalExit ?? createFatalExitAdapter())
		: options.fatalExit;
	const attachmentInstance = createHubAttachmentInstance();
	const holder: RuntimeControllerHolder = {
		controller: options.controller ?? null,
	};

	return (pi: ExtensionAPI): void => {
		const runtime = createDecisionRuntime({
			pi,
			hub,
			processDomain,
			fatalExit,
			attachmentInstance,
			controllerHolder: holder,
			injectedController: options.controller !== undefined,
			initialConfig: options.config,
			clock: options.clock,
			createExchangeId: options.createExchangeId,
			loadConfig: options.loadConfig,
			agentDir: options.agentDir,
		});

		createMainCommands(pi, {
			get controller() {
				return holder.controller;
			},
			isCurrentMain: runtime.isCurrentMain,
			getTriggerStatus: runtime.getTriggerStatus,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			restartLockCycle: (ctx, restartOptions) =>
				runtime.restartLockCycle(ctx, restartOptions),
			clearOperationalPendingWork: () => runtime.clearOperationalPendingWork(),
			applyEffect: runtime.applyEffect,
			reconcileIdle: runtime.reconcileIdle,
		});
		registerDecisionContextFolding(pi);
		// Correlate a pending watchdog dispatch before real-user auto-lock can
		// restart the cycle and discard the identity needed to downgrade a foreign run.
		pi.on("message_start", runtime.handleMessageStart);

		registerMainUserAutoLock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			onMainUserMessageStart(): void {
				runtime.restartLockCycle(undefined, { notifyLocked: false });
			},
		});

		const abortUnlock = registerMainAbortUnlock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			get controller() {
				return holder.controller;
			},
			clearOperationalPendingWork: () => runtime.clearOperationalPendingWork(),
			consumeDecisionAbortSuppression: () =>
				runtime.consumeDecisionAbortSuppression(),
			applyEffect: runtime.applyEffect,
		});

		// Abort handlers register first; Pi awaits event handlers in registration order.
		runtime.registerLifecycle();

		pi.on("session_shutdown", async (_event, _ctx: ExtensionContext) => {
			abortUnlock.clear();
			await runtime.shutdown();
			fatalExit?.completeShutdown();
		});
	};
}

export default function registerContinueWatchdogExtension(
	pi: ExtensionAPI,
): void {
	createContinueWatchdogExtension()(pi);
}
