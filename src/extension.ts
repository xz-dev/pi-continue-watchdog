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
import {
	createHubAttachmentInstance,
	getProcessObservableAgentHub,
	type ObservableAgentHub,
} from "./hub.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeControllerHolder,
} from "./runtime.js";

/** Dependencies supplied only by focused lifecycle tests. */
export interface ContinueWatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
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
	const attachmentInstance = createHubAttachmentInstance();
	const holder: RuntimeControllerHolder = {
		controller: options.controller ?? null,
	};

	return (pi: ExtensionAPI): void => {
		const runtime = createDecisionRuntime({
			pi,
			hub,
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
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			restartLockCycle: (ctx, restartOptions) =>
				runtime.restartLockCycle(ctx, restartOptions),
			clearOperationalPendingWork: () => runtime.clearOperationalPendingWork(),
			applyEffect: runtime.applyEffect,
			reconcileIdle: runtime.reconcileIdle,
		});
		registerDecisionContextFolding(pi);

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
			applyEffect: runtime.applyEffect,
		});

		// Abort handlers register first; Pi awaits event handlers in registration order.
		runtime.registerLifecycle();

		pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
			abortUnlock.clear();
			runtime.shutdown();
		});
	};
}

export default function registerContinueWatchdogExtension(
	pi: ExtensionAPI,
): void {
	createContinueWatchdogExtension()(pi);
}
