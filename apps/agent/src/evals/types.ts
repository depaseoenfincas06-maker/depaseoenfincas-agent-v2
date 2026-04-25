/**
 * Eval case definition. Used to detect regressions on known-bad cases (the 13
 * silence cases from production) and validate intent classification.
 *
 * Cases live in tests/evals/*.jsonl. Each line is one EvalCase.
 */
export interface EvalCase {
  id: string;
  description?: string;
  /** What the user "said" — text or audio simulation. */
  input:
    | { kind: 'text'; text: string }
    | { kind: 'audio_empty' }
    | { kind: 'audio_failed' };
  /** Snapshot of conversation context at the start of the turn. */
  context?: {
    stage?: 'QUALIFYING' | 'OFFERING' | 'VERIFYING_AVAILABILITY' | 'CONFIRMING_RESERVATION' | 'HITL';
    searchCriteria?: Record<string, unknown>;
    shownFincas?: string[];
    selectedFinca?: string;
    agenteActivo?: boolean;
  };
  /** What we expect to be true after the turn. ALL must hold for the case to pass. */
  expect: {
    /** Trace status must be one of these. */
    status?: Array<'ok' | 'silent' | 'fallback' | 'error'>;
    /** outbound_count must be >= this (default 1). */
    minOutbounds?: number;
    /** intent equals one of these. */
    intent?: string[];
    /** stage_after equals one of these. */
    stageAfter?: string[];
    /** outbound text must contain ALL these substrings (case-insensitive). */
    outboundContainsAll?: string[];
    /** outbound text must NOT contain ANY of these substrings. */
    outboundContainsNone?: string[];
    /** Router decision must equal this. */
    routedTo?: 'qa' | 'hitl' | 'stage';
  };
}

export interface EvalResult {
  case: EvalCase;
  passed: boolean;
  failures: string[];
  trace?: {
    status: string;
    intent: string | null;
    stageAfter: string | null;
    outboundCount: number;
    outboundTexts: string[];
    durationMs: number | null;
  };
  error?: string;
}
