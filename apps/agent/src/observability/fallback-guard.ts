/**
 * The "always respond" invariant. Every orchestrator turn ends through this
 * function. It guarantees:
 *   - If we have outbound messages → return them, status=ok
 *   - If we explicitly silenced (HITL, duplicate, OOO) → return [], status=silent
 *   - Otherwise → emit a generic fallback message + log a fallback_events row
 *
 * The fallback is not pretty — it exists so the user is never abandoned. If
 * it fires often, the dashboard surfaces it and we fix the underlying cause.
 */
import type { OutboundMessage, FallbackReason, SilenceReason, Channel } from '@depf/shared';
import type { Trace } from './tracer.js';
import { logger } from './logger.js';

export const GENERIC_FALLBACK_MESSAGE =
  'Disculpa, tuve un inconveniente procesando tu mensaje. ¿Me lo puedes repetir o reformular, por favor?';

export const TRANSCRIPTION_FALLBACK_MESSAGE =
  'No logré entender tu audio. ¿Me lo puedes escribir o intentar de nuevo más cerca del micrófono?';

export interface GuardInput {
  trace: Trace;
  conversationId: string;
  channel: Channel;
  outbound: OutboundMessage[];
  silenceReason: SilenceReason | null;
  /** If set, we're emitting a fallback — caller already knew something went wrong. */
  fallbackReason?: FallbackReason;
  /** Extra context attached to the fallback_events row. */
  context?: Record<string, unknown>;
}

export interface GuardOutput {
  outbound: OutboundMessage[];
  status: 'ok' | 'silent' | 'fallback';
  silenceReason: SilenceReason | null;
}

export async function applyAlwaysRespondGuard(input: GuardInput): Promise<GuardOutput> {
  // Explicit silence: respect it.
  if (input.silenceReason) {
    return { outbound: [], status: 'silent', silenceReason: input.silenceReason };
  }

  // We have outbound: happy path.
  if (input.outbound.length > 0 && !input.fallbackReason) {
    return { outbound: input.outbound, status: 'ok', silenceReason: null };
  }

  // Need to emit fallback. Either caller asked us to, or no outbound + no reason.
  const reason: FallbackReason = input.fallbackReason ?? 'NO_OUTBOUND_NO_REASON';
  const message: OutboundMessage = {
    channel: input.channel,
    type: 'text',
    text:
      reason === 'TRANSCRIPTION_EMPTY'
        ? TRANSCRIPTION_FALLBACK_MESSAGE
        : GENERIC_FALLBACK_MESSAGE,
  };

  await input.trace.recordFallback(input.conversationId, reason, input.context ?? {});
  logger.warn(
    { conversationId: input.conversationId, traceId: input.trace.id, reason, context: input.context },
    'fallback triggered',
  );

  return {
    outbound: [...input.outbound, message],
    status: 'fallback',
    silenceReason: null,
  };
}
