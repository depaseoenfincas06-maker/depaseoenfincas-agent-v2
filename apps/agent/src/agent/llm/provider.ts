/**
 * LLM provider abstraction. We force structured JSON output and validate
 * with zod so a malformed response is recoverable, not a crash.
 *
 * Stages depend on this interface, not on Gemini specifically — swapping to
 * Anthropic / OpenAI / etc. is a matter of writing a new implementation.
 */
import type { z } from 'zod';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest<TSchema extends z.ZodTypeAny> {
  /** Logical name for telemetry (e.g. 'qualifying-stage', 'intent-classifier'). */
  name: string;
  messages: LLMMessage[];
  /** Schema the LLM output must match after JSON.parse. */
  schema: TSchema;
  /** Optional: cap response tokens. */
  maxTokens?: number;
  /** Optional: temperature override (default 0.2 for stages, 0 for routers). */
  temperature?: number;
  /** Optional: per-call timeout in ms (default 30s). */
  timeoutMs?: number;
}

export interface LLMUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LLMResult<TSchema extends z.ZodTypeAny> {
  data: z.infer<TSchema>;
  rawText: string;
  usage: LLMUsage;
  model: string;
  latencyMs: number;
}

export interface LLMError extends Error {
  kind: 'malformed' | 'timeout' | 'transport' | 'validation' | 'unknown';
  rawText?: string;
  attempts?: number;
  /** Compact summary of zod validation issues, used for retry guidance. */
  issues?: string;
}

export interface LLMProvider {
  readonly name: 'gemini' | 'anthropic';
  generate<TSchema extends z.ZodTypeAny>(req: LLMRequest<TSchema>): Promise<LLMResult<TSchema>>;
}

export function createLLMError(
  kind: LLMError['kind'],
  message: string,
  extras?: Partial<LLMError>,
): LLMError {
  const err = new Error(message) as LLMError;
  err.kind = kind;
  if (extras) Object.assign(err, extras);
  return err;
}
