/**
 * Identity probe for process-domain loading.
 *
 * Loaded only through Pi's public DefaultResourceLoader so each distinct-cwd
 * evaluation re-imports the real hub module the same way independent child
 * sessions re-evaluate the extension. The probe records the process hub from
 * getProcessObservableAgentHub() — never createObservableAgentHub().
 */

import {
	getProcessObservableAgentHub,
	type ObservableAgentHub,
} from "../../src/hub.js";

/** Unique object identity for one jiti/module evaluation of this file. */
const moduleEvaluationIdentity = {
	id: Symbol("process-domain-module-evaluation"),
};

const PROCESS_DOMAIN_CAPTURE_KEY = Symbol.for(
	"pi-continue-watchdog:test:process-domain-captures",
);

export interface ProcessDomainCapture {
	readonly hub: ObservableAgentHub;
	readonly moduleEvaluationIdentity: typeof moduleEvaluationIdentity;
}

type CaptureHost = typeof globalThis & {
	[PROCESS_DOMAIN_CAPTURE_KEY]?: ProcessDomainCapture[];
};

function captureHost(): CaptureHost {
	return globalThis as CaptureHost;
}

/** Read captures written by DefaultResourceLoader-evaluated probe factories. */
export function getProcessDomainCaptures(): readonly ProcessDomainCapture[] {
	return [...(captureHost()[PROCESS_DOMAIN_CAPTURE_KEY] ?? [])];
}

/** Clear prior captures before a focused loading scenario. */
export function resetProcessDomainCaptures(): void {
	captureHost()[PROCESS_DOMAIN_CAPTURE_KEY] = [];
}

/** Pi extension factory: record the process hub acquired in this evaluation. */
export default function registerProcessDomainIdentityProbe(): void {
	const host = captureHost();
	host[PROCESS_DOMAIN_CAPTURE_KEY] ??= [];
	const list = host[PROCESS_DOMAIN_CAPTURE_KEY];
	list.push({
		hub: getProcessObservableAgentHub(),
		moduleEvaluationIdentity,
	});
}
