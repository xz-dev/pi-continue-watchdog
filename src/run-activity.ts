/** Versioned wire metadata shared by extensions that participate in process-domain activity accounting. */
export const PROCESS_DOMAIN_ACTIVITY_KEY = "pi-process-domain";
export const PROCESS_DOMAIN_ACTIVITY_VERSION = 1;

export const PROCESS_DOMAIN_OBSERVATION_DETAILS = {
	[PROCESS_DOMAIN_ACTIVITY_KEY]: {
		version: PROCESS_DOMAIN_ACTIVITY_VERSION,
		activity: "observation",
	},
} as const;
