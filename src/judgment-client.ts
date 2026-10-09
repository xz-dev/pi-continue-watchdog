/**
 * Copy-able, self-contained client for the pi-llm-as-jev judgment service.
 *
 * This file is the CANONICAL type source for the public contract (D1):
 * `src/contract.ts` re-exports these types, it does not duplicate them.
 * No dependency on the extension package at runtime. Consumers may copy this
 * file into their own extension instead of importing from `pi-llm-as-jev`.
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

export interface EvidenceRecord {
	id: string;
	text: string;
	metadata?: JsonObject;
}

export interface JudgeRequest {
	/** Fixed state; unchanged when evidence is subdivided. */
	state: JsonObject;
	questions: Record<string, ClassifierQuestion>;
	/** Stable unique ids, original order. */
	evidence?: EvidenceRecord[];
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
	/** Actual LLM: per-attempt streaming inactivity; native classifier: one whole-call deadline. */
	timeoutMs?: number;
	/** Force a review; retries within this token reuse new judgments. */
	fresh?: string;
}

export interface JudgeResult {
	/** Final accepted view only. */
	answers: Record<string, ClassifierAnswer>;
	dropped: string[];
	backend: "classifier" | "llm";
	/** `provider/modelid`. */
	model: string;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	contextOverflow?: boolean;
	reuse: { hits: number; joined: number; sent: number };
	/** Reported nested usage only, never invented. */
	usage?: Usage;
	/** Capacity in force for this call's overflow prediction (capacityVersion 1). */
	capacity?: CapacityDisclosure;
	/** Logical backend dispatch input sizes, before SDK transport wrapping.
	 * These are UTF-8 bytes, not tokens, HTTP retry counts or provider usage.
	 * Empty means no dispatch; absent means setup failed before collection.
	 */
	inputDimensions?: {
		stateBytes: number;
		questionBytes: number;
		longestQuestionBytes: number;
	}[];
}

/**
 * Capacity disclosure (capacityVersion 1): the selected backend/model and the
 * input limits the service applies to its overflow prediction. Limits are
 * declared, not proven: `source` says where each came from. Absent limits
 * mean unknown metadata, never an inferred value.
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
	limitSource: "override" | "channel" | "model" | "none";
	/** Usable input tokens per sent UTF-8 byte: learned from usage, else the prior. */
	tokensPerByte: number;
	/** True while `tokensPerByte` is the conservative prior, not provider-reported usage. */
	prior: boolean;
	/** Bytes the service reserves for its own LLM request envelope (0 for native). */
	envelopeOverheadBytes: number;
}

export interface JudgmentService {
	version: 1;
	judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
	availability(): Promise<{ classifier?: string; llm?: string }>;
	/** Presence advertises `describeSelection()` and `JudgeResult.capacity`. */
	capacityVersion?: 1;
	/**
	 * Resolve what a judgment would use now and its declared capacity. Read-only:
	 * no inference, no writes, no cache mutation. Error when no backend resolves.
	 */
	describeSelection?(opts?: {
		signal?: AbortSignal;
		/** Which entry point the limits are for; `review` applies built-in channel constants. Default `judge`. */
		path?: "judge" | "review";
	}): Promise<CapacityDisclosure | { error: string }>;
}

// ---------------------------------------------------------------------------
// Resumable review extension (reviewVersion 1) — additive, final-only.
// ---------------------------------------------------------------------------

export interface ReviewEvidenceFrame {
	record: EvidenceRecord;
	/** Service-generated UTF-16 bounds; never inferred from caller metadata. */
	bounds?: { of: string; start: number; end: number; total: number };
}

export interface ReviewStageProjection {
	state: JsonObject;
	/** Full stage questions. Omitted original ids must be explicitly unresolved. */
	questions: Record<string, ClassifierQuestion>;
	/** Withheld ids (not also dispatchable); all-withheld projections may have no questions. */
	unresolved?: string[];
}

/**
 * Consumer-owned durable raw results. Keys are opaque, versioned and computed after actual selection/projection.
 * @deprecated Consumers persist their own judgment state; kept callable for reviewVersion 1 clients.
 */
export interface ReviewCache {
	/** Return only an acknowledged result from the current consumer scope; the service revalidates it. */
	lookup(key: string): unknown;
	/** Synchronous durability acknowledgement. False/throw never advances consumer progress. */
	store(key: string, answer: ClassifierAnswer): boolean;
}

export interface ReviewOptions extends JudgeOptions {
	/**
	 * Requires reviewCacheVersion: 1. Independent of the service's legacy checkpoint ledger.
	 * @deprecated Not required for correctness; the service does not depend on it.
	 */
	cache?: ReviewCache;
	/**
	 * @deprecated Business staging belongs to the consumer; pack input via describeSelection().
	 * Requires reviewStagesVersion: 1 and projectionRevision. Return strictly increasing
	 * exclusive frame ends for sealed business prefixes. Each is provisional; the
	 * remaining tail (possibly empty) is final. Frames cannot be omitted or reordered.
	 * The entire plan retains one admitted backend and native whole-call deadline.
	 */
	planStages?: (evidence: readonly ReviewEvidenceFrame[]) => readonly number[];
	/** @deprecated Stable business scope/revision, required when projectStage is provided. */
	projectionRevision?: string;
	/** @deprecated See planStages. */
	projectStage?: (stage: {
		evidence: readonly ReviewEvidenceFrame[];
		completed: readonly ReviewEvidenceFrame[];
		previousAnswers: Readonly<Record<string, ClassifierAnswer>>;
		final: boolean;
	}) => ReviewStageProjection;
	/** @deprecated Advisory seed id, validated by the service against the active branch. */
	checkpoint?: string;
	/** @deprecated Notification only; synchronous exceptions/rejected promises are isolated. */
	onProgress?: (progress: ReviewStageProgress) => void;
}

/** One completed stage acknowledged as durable progress. Read-only view. */
export interface ReviewStageProgress {
	final: boolean;
	checkpoint: string;
	/** Genuine bounds for receipt consumers; no source text or metadata. */
	sources: { id: string; bounds?: ReviewEvidenceFrame["bounds"] }[];
	/** Raw current opinions, advisory only, never factual coverage or final advice. */
	opinions: Record<string, ClassifierAnswer>;
	/** Ordered evidence ids this stage covered (fragment ids keep their bounds suffix). */
	evidenceIds: string[];
	/** Whether the service acknowledged this stage as durably checkpointed. */
	durable: boolean;
	/** Consumer-cache acknowledgement, separate from service checkpoint durability and legacy onProgress. */
	cache?: { keys: string[]; durable: boolean };
}

/** Completed-stage observations; inspect `durable` before claiming persistence. */
export interface ReviewProgress {
	stages: ReviewStageProgress[];
}

/** One observed provider transport attempt (adapter observation contract v1). */
export interface ReviewAttemptObservation {
	/** Stable id within this review call: `<operation>#<ordinal>`. */
	id: string;
	/** 1-based ordinal of the actual transport attempt. */
	ordinal: number;
	outcome?: "response" | "network" | "timeout" | "aborted";
	/** HTTP status when a response was received. */
	status?: number;
	/** Model id reported in the response, when the adapter supplied one. */
	model?: string;
	/** Provider-reported input tokens; absent when the attempt did not report them. */
	inputTokens?: number;
	/** Provider-reported output tokens; absent when not reported. */
	outputTokens?: number;
	/** Provider-reported USD charge; absent when not reported. Never a catalog estimate. */
	costUsd?: number;
	/** Pi catalog estimate, never a provider-reported charge. */
	catalogCostUsd?: number;
	/** Typed error category when the attempt did not produce a usable response. */
	errorCategory?: string;
	stateBytes?: number;
	questionBytes?: number;
	longestQuestionBytes?: number;
	/** Latest state; start without end explicitly means unfinished at settlement. */
	phase: "start" | "end";
}

/** Per-field known-sum/missing-count usage; absence is never zero. */
export interface ReviewUsageField {
	/** Sum of provider-reported values; 0 with `missing > 0` means "at least 0". */
	knownSum: number;
	/** Attempts that did not report this field. */
	missing: number;
}

/** Presence-aware usage totals across observed attempts. */
export interface ReviewUsageTotals {
	inputTokens: ReviewUsageField;
	outputTokens: ReviewUsageField;
	costUsd: ReviewUsageField;
}

export interface ReviewDiagnostics {
	/** Service-owned transport-scoped capacity channel digest, once selected. */
	channel?: string;
	/** Subdivisions caused by a capacity prediction before dispatch; not attempts. */
	presplits?: number;
	/** Dispatch candidates skipped using recorded rejections; not new rejections. */
	rejectedReuses?: number;
	/** Actual transport attempts observed through the adapter contract. */
	attempts: ReviewAttemptObservation[];
	/** Observed starts (`attempts.length`); unavailable coverage does not prove zero work. */
	attemptCount: number;
	/** Presence-aware usage totals; never invented from catalog estimates. */
	usage: ReviewUsageTotals;
	/** Estimate over reported usage; missing inputs/outputs keep the estimate partial. */
	catalogCostUsd?: ReviewUsageField;
	/** Whether the adapter acknowledged the observation contract for every dispatch. */
	observationCoverage: "complete" | "unavailable";
}

/** Review result: final answers plus durable progress and attempt diagnostics. */
export interface ReviewResult extends JudgeResult {
	/** Durable completed-stage progress; volatile stages carry `durable: false`. */
	progress: ReviewProgress;
	/** Honest per-attempt diagnostics from the adapter observation contract. */
	diagnostics: ReviewDiagnostics;
	unresolved: string[];
}

/**
 * Review extension discovery. Present only when the service also provides
 * `review()`; absence means the old final-only service.
 */
export interface ReviewService extends JudgmentService {
	reviewVersion: 1;
	/** @deprecated Presence advertises the optional consumer-owned cache port and stage cache acknowledgements. */
	reviewCacheVersion?: 1;
	/** @deprecated Generic business-directed source partitioning under one logical execution. */
	reviewStagesVersion?: 1;
	/**
	 * Resumable review: durably records completed stages, reuses validated
	 * raw answers, reports actual attempts. A failed or aborted review still
	 * exposes no final answers (`answers: {}`).
	 */
	review(req: JudgeRequest, opts?: ReviewOptions): Promise<ReviewResult>;
}

/** Global registry key published by the extension at startup. */
const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");

/**
 * Look up the judgment service at call time. Returns `undefined` when the
 * `pi-llm-as-jev` extension is not installed/running.
 */
export function getJudgmentService(): JudgmentService | undefined {
	return (globalThis as Record<symbol, JudgmentService | undefined>)[
		SERVICE_KEY
	];
}
