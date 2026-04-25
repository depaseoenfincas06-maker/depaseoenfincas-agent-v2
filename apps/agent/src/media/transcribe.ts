/**
 * Robust audio transcription. Strategy:
 *
 *   1. Validate the audio (duration, mime type) before spending an API call.
 *   2. Build a domain-bias prompt from inventory + recent conversation context.
 *   3. Call the primary model (gpt-4o-transcribe, full).
 *   4. If the result is empty/whitespace, retry with a different model family
 *      (whisper-1) — this catches cases where one model is over-aggressive
 *      about silence detection.
 *   5. If both attempts return empty, mark transcription_status='empty'. The
 *      orchestrator will surface a "couldn't understand, please retype" message
 *      — but this should be RARE, not a default behavior.
 *
 * We persist every attempt's result so the dashboard can show why a particular
 * audio fell through.
 */
import { Buffer } from 'node:buffer';
import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

export interface AudioInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  durationSec: number | null;
}

export interface TranscriptionAttempt {
  model: string;
  text: string;
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

export interface TranscriptionResult {
  ok: boolean;
  text: string;
  status: 'ok' | 'empty' | 'failed';
  attempts: TranscriptionAttempt[];
  reason?: string;
}

const VALID_MIME_PREFIXES = ['audio/', 'video/'];
const MIN_DURATION_SEC = 0.4;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
    _client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return _client;
}

export interface TranscribeOptions {
  /**
   * Domain bias prompt — names of fincas in inventory, common Colombian
   * Spanish phrases, recent message context. Whisper uses this to bias
   * tokens (especially proper nouns).
   */
  domainPrompt?: string;
  /** Conversation language. Defaults to Spanish. */
  language?: string;
}

function isEmptyText(s: string | null | undefined): boolean {
  if (!s) return true;
  const trimmed = s.trim();
  if (!trimmed) return true;
  // Whisper sometimes returns "you" or punctuation-only on silence.
  if (/^[\s.,;:!?¡¿—\-_*"']+$/u.test(trimmed)) return true;
  if (trimmed.length <= 2 && /^[a-z]+$/i.test(trimmed)) return true;
  return false;
}

async function tryModel(
  model: string,
  audio: AudioInput,
  opts: TranscribeOptions,
): Promise<TranscriptionAttempt> {
  const startedAt = Date.now();
  try {
    const file = await toFile(audio.buffer, audio.filename, { type: audio.mimeType });
    const result = await client().audio.transcriptions.create({
      file,
      model,
      language: opts.language ?? 'es',
      ...(opts.domainPrompt ? { prompt: opts.domainPrompt } : {}),
      temperature: 0,
      response_format: 'json',
    });
    const text = result.text ?? '';
    return {
      model,
      text,
      ok: !isEmptyText(text),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      model,
      text: '',
      ok: false,
      latencyMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function transcribe(
  audio: AudioInput,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const attempts: TranscriptionAttempt[] = [];

  // Validation
  if (!VALID_MIME_PREFIXES.some((p) => audio.mimeType.startsWith(p))) {
    return {
      ok: false,
      text: '',
      status: 'failed',
      attempts,
      reason: `unsupported mime type: ${audio.mimeType}`,
    };
  }
  if (audio.durationSec != null && audio.durationSec < MIN_DURATION_SEC) {
    return {
      ok: false,
      text: '',
      status: 'failed',
      attempts,
      reason: `audio too short: ${audio.durationSec}s`,
    };
  }
  if (audio.buffer.length === 0) {
    return { ok: false, text: '', status: 'failed', attempts, reason: 'empty buffer' };
  }

  // Attempt 1: primary
  const a1 = await tryModel(config.OPENAI_TRANSCRIPTION_MODEL, audio, opts);
  attempts.push(a1);
  if (a1.ok) return { ok: true, text: a1.text.trim(), status: 'ok', attempts };

  logger.info(
    { model: a1.model, latencyMs: a1.latencyMs, error: a1.errorMessage },
    'primary transcription returned empty/error, trying fallback',
  );

  // Attempt 2: fallback
  const a2 = await tryModel(config.OPENAI_TRANSCRIPTION_FALLBACK_MODEL, audio, opts);
  attempts.push(a2);
  if (a2.ok) return { ok: true, text: a2.text.trim(), status: 'ok', attempts };

  // Both empty — declare empty (not failed). Orchestrator will emit fallback.
  const allErrored = attempts.every((a) => a.errorMessage);
  return {
    ok: false,
    text: '',
    status: allErrored ? 'failed' : 'empty',
    attempts,
    reason: allErrored ? 'all attempts errored' : 'all attempts returned empty text',
  };
}

export function buildDomainPrompt(input: {
  fincaCodes?: string[];
  recentUtterances?: string[];
  baseline?: string;
}): string {
  const parts: string[] = [];
  parts.push(
    input.baseline ??
      'Conversación en español colombiano sobre alquiler de fincas vacacionales. Vocabulario común: finca, parcelación, hectáreas, capacidad, jacuzzi, piscina, asado, BBQ, anfitrión, propietario.',
  );
  if (input.fincaCodes?.length) {
    parts.push(`Códigos de fincas: ${input.fincaCodes.slice(0, 30).join(', ')}.`);
  }
  if (input.recentUtterances?.length) {
    parts.push(`Contexto reciente: ${input.recentUtterances.slice(-3).join(' / ')}`);
  }
  return parts.join(' ');
}
