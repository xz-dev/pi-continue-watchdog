/**
 * Copy-able, self-contained client for the pi-llm-as-jev judgment service.
 *
 * This file is the CANONICAL type source for the public contract (D1):
 * `src/contract.ts` re-exports these types, it does not duplicate them.
 * No dependency on the extension package at runtime. Consumers may copy this
 * file into their own extension instead of importing from `pi-llm-as-jev`.
 *
 * VERSION TWO (stateless): the service exposes only `judge()`,
 * `availability()` and `describeSelection()`. Review, checkpoints, stage
 * projections, result caching/in-flight joins, persistent ledgers, capacity
 * learning and transport-attempt observations are REMOVED. Consumers pack
 * every necessary fact into `state` and own their own business progress.
 */

/** Structural copy of pi-ai `JsonValue`. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;

/** Structural copy of pi-ai `JsonObject`. */
export type JsonObject = { [key: string]: JsonValue };

/** Structural copies of pi-ai classifier question shapes. */
export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	criteria: {
		true: string;
		false: string;
	};
}

export type ClassifierQuestion =
	| ClassifierChoiceQuestion
	| ClassifierScoreQuestion
	| ClassifierBoolQuestion;

/** Structural copies of pi-ai classifier answer shapes. */
export interface ClassifierChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ClassifierScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

export interface ClassifierBoolAnswer {
	type: "bool";
	probability: number;
}

export type ClassifierAnswer =
	| ClassifierChoiceAnswer
	| ClassifierScoreAnswer
	| ClassifierBoolAnswer;

/** Structural copy of pi-ai `Usage`. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Anthropic only. */
	cacheWrite1h?: number;
	/** Subset of `output` reported by providers with a reasoning breakdown. */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface JudgeRequest {
	/**
	 * Fixed caller state: every fact the questions need lives here. The
	 * service never crops, summarizes or subdivides caller facts.
	 */
	state: JsonObject;
	questions: Record<string, ClassifierQuestion>;
	/**
	 * REMOVED in version two: pack evidence records into `state`. Supplying
	 * this legacy field is an explicit invalid-request error, never ignored.
	 */
	evidence?: never;
}

/**
 * Per-question acceptance rule for native-classifier answers. Replaces (does
 * not stack with) the `minConfidence` default for that question. A
 * `choiceProbability` rule must name an existing choice key.
 */
export type ThresholdRule =
	| { metric: "confidence"; minimum: number }
	| { metric: "choiceProbability"; choice: string; minimum: number };

export interface JudgeOptions {
	/** Default policy for supported native classifier fields. */
	minConfidence?: number;
	/** Per-question override of `minConfidence`. */
	thresholds?: Record<string, ThresholdRule>;
	signal?: AbortSignal;
	/**
	 * Generation-progress idle duration (ms), applied independently to EACH
	 * attempted backend family. Only nonempty generated text, reasoning or
	 * tool-argument deltas — or a validated completed question answer —
	 * renew idle waiting. Headers, heartbeats, empty events, request starts
	 * and retries do not. Defaults: classifier 10,000 ms, LLM 15,000 ms.
	 */
	idleTimeoutMs?: number;
	/**
	 * Optional whole-model-attempt hard limit (ms) covering setup, every
	 * question and the single permitted LLM output repair, per attempted
	 * family independently. Absent means no hard limit; it is never derived
	 * from any idle value or host HTTP setting. There is no combined
	 * primary-plus-alternate deadline: an automatic alternate receives
	 * fresh independent clocks.
	 */
	modelTimeoutMs?: number;
	/** REMOVED in version two: the ambiguous legacy duration field. */
	timeoutMs?: never;
	/** REMOVED in version two: forced review tokens no longer exist. */
	fresh?: never;
	/** REMOVED in version two: consumer result caches no longer exist. */
	cache?: never;
	/** REMOVED in version two: service-side staging was removed. */
	planStages?: never;
	/** REMOVED in version two: service-side staging was removed. */
	projectStage?: never;
	/** REMOVED in version two: service-side staging was removed. */
	projectionRevision?: never;
	/** REMOVED in version two: checkpoints no longer exist. */
	checkpoint?: never;
	/** REMOVED in version two: stage progress no longer exists. */
	onProgress?: never;
}

export interface JudgeResult {
	/** Final accepted view of the terminal attempt only. */
	answers: Record<string, ClassifierAnswer>;
	dropped: string[];
	backend: "classifier" | "llm";
	/** `provider/modelid` of the model that produced the terminal outcome. */
	model: string;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	/**
	 * Terminal attempt's model explicitly rejected the input for context
	 * size. Never set from an earlier non-terminal failure: an overflow
	 * primary followed by an authentication-failed alternate reports no
	 * stale overflow flag.
	 */
	contextOverflow?: boolean;
	/** Reported backend usage only, never invented or claimed complete. */
	usage?: Usage;
	/**
	 * Declared capacity in force for the TERMINAL attempt's model
	 * (capacityVersion 2): identity plus declared limits, no learned ratios.
	 */
	capacity?: CapacityDisclosure;
}

/**
 * Capacity disclosure (capacityVersion 2): the selected backend/model and
 * its declared input limits. Limits are declared, not proven: `limitSource`
 * says where they came from. Absent limits mean unknown metadata, never an
 * inferred or learned value.
 */
export interface CapacityDisclosure {
	backend: "classifier" | "llm";
	/** `provider/modelid`. */
	model: string;
	/** Tokens. Any field may be absent when no metadata declares it. */
	limits: {
		request?: number;
		stateAndLongestQuestion?: number;
		contextWindow?: number;
	};
	/** Where `limits` came from; `none` when every field is absent. */
	limitSource: "override" | "model" | "none";
}

export interface JudgmentService {
	version: 2;
	judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
	availability(): Promise<{ classifier?: string; llm?: string }>;
	/** Presence advertises `describeSelection()` and `JudgeResult.capacity`. */
	capacityVersion?: 2;
	/**
	 * Resolve what a judgment would use now and its declared capacity.
	 * Read-only: no inference, no writes, no persistent state. Error when no
	 * backend resolves.
	 */
	describeSelection?(opts?: {
		signal?: AbortSignal;
	}): Promise<CapacityDisclosure | { error: string }>;
}

/** Global registry key published by the extension at startup. */
const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");

/**
 * Look up the judgment service at call time. Returns `undefined` when the
 * `pi-llm-as-jev` extension is not installed/running, and may return an
 * incompatible (version-one or foreign) handle: check `version === 2`
 * before calling `judge()`.
 */
export function getJudgmentService(): JudgmentService | undefined {
	return (globalThis as Record<symbol, JudgmentService | undefined>)[
		SERVICE_KEY
	];
}
