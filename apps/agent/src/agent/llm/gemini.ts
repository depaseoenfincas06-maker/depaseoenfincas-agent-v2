/**
 * Gemini implementation of LLMProvider. We use response_mime_type=application/json
 * to force JSON output, then validate with zod. On parse/validation failure we
 * retry once with a stricter "FIX YOUR JSON" message — bounded so we never loop.
 */
import { GoogleGenerativeAI, type GenerationConfig } from '@google/generative-ai';
import type { z } from 'zod';
import { config } from '../../config.js';
import { logger } from '../../observability/logger.js';
import {
  createLLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
} from './provider.js';

const MAX_PARSE_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

// Flash pricing (approximate, USD per 1M tokens). Keep updated.
const PRICING = {
  in: 0.075 / 1_000_000,
  out: 0.3 / 1_000_000,
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(createLLMError('timeout', `${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function extractJson(text: string): string {
  // Gemini sometimes wraps JSON in ```json fences despite mime type.
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = trimmed.match(fence);
  return match?.[1] ?? trimmed;
}

class GeminiProvider implements LLMProvider {
  readonly name = 'gemini' as const;
  private client: GoogleGenerativeAI;

  constructor() {
    if (!config.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    this.client = new GoogleGenerativeAI(config.GEMINI_API_KEY);
  }

  async generate<TSchema extends z.ZodTypeAny>(
    req: LLMRequest<TSchema>,
  ): Promise<LLMResult<TSchema>> {
    const model = this.client.getGenerativeModel({
      model: config.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxTokens ?? 2048,
      } satisfies GenerationConfig,
    });

    const systemMsg = req.messages.find((m) => m.role === 'system');
    const conversation = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const startedAt = Date.now();
    let lastError: unknown = null;
    let rawText = '';
    let attempt = 0;

    while (attempt <= MAX_PARSE_RETRIES) {
      attempt += 1;
      try {
        const result = await withTimeout(
          model.generateContent({
            contents: conversation,
            ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
          }),
          req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          `gemini.${req.name}`,
        );
        rawText = result.response.text();
        const cleaned = extractJson(rawText);
        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned);
        } catch (parseErr) {
          // Re-throw as SyntaxError so the catch below triggers a corrective retry.
          throw parseErr;
        }
        const validated = req.schema.safeParse(parsed);
        if (!validated.success) {
          // Build a compact human-readable summary of the validation issues,
          // suitable to feed back to the LLM as corrective guidance.
          const issues = validated.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .slice(0, 6)
            .join('; ');
          const validationErr = createLLMError('validation', 'response did not match schema', {
            rawText,
            issues,
          });
          throw validationErr;
        }
        const usage = result.response.usageMetadata;
        const tokensIn = usage?.promptTokenCount ?? 0;
        const tokensOut = usage?.candidatesTokenCount ?? 0;
        return {
          data: validated.data,
          rawText,
          model: config.GEMINI_MODEL,
          latencyMs: Date.now() - startedAt,
          usage: {
            tokensIn,
            tokensOut,
            costUsd: tokensIn * PRICING.in + tokensOut * PRICING.out,
          },
        };
      } catch (err) {
        lastError = err;
        const kind = (err as { kind?: string }).kind;
        if (err instanceof SyntaxError) {
          // Parse failure — try once more with a corrective message.
          conversation.push(
            { role: 'model', parts: [{ text: rawText }] },
            {
              role: 'user',
              parts: [
                {
                  text: 'Tu respuesta anterior no era JSON válido. Responde SOLO con un JSON que cumpla el schema. Sin texto adicional, sin markdown.',
                },
              ],
            },
          );
          continue;
        }
        if (kind === 'validation' && attempt <= MAX_PARSE_RETRIES) {
          // Validation failure — retry with the specific issues quoted, so the
          // LLM can fix THAT exact problem instead of guessing.
          const issues = (err as { issues?: string }).issues ?? '';
          conversation.push(
            { role: 'model', parts: [{ text: rawText }] },
            {
              role: 'user',
              parts: [
                {
                  text: `Tu respuesta JSON no cumple el schema. Errores: ${issues}. Responde SOLO con un JSON válido corrigiendo esos campos. Recuerda: "intent" debe ser uno de los enum permitidos (GREETING, QUALIFYING, SHOW_OPTIONS, CLIENT_CHOSE, ADJUST_CRITERIA, NO_MATCH, WAITING_OWNER, CHANGE_FINCA, REQUEST_CONFIRMATION_DATA, DOCUMENT_READY, QUESTION, QA_ANSWERED, OFF_TOPIC, HITL_REQUEST, CANCEL); "tool_calls" es un array (use [] vacío si no hay); "extracted_data" es un objeto (use {} vacío si no hay).`,
                },
              ],
            },
          );
          continue;
        }
        // Timeout, transport, or out of retries — break early
        break;
      }
    }

    logger.warn({ name: req.name, attempt, lastError }, 'gemini generate failed');
    if (lastError && (lastError as { kind?: string }).kind) throw lastError;
    throw createLLMError(
      'malformed',
      `gemini failed after ${attempt} attempts`,
      { rawText, attempts: attempt },
    );
  }
}

let cached: GeminiProvider | null = null;
export function getGeminiProvider(): GeminiProvider {
  if (!cached) cached = new GeminiProvider();
  return cached;
}
