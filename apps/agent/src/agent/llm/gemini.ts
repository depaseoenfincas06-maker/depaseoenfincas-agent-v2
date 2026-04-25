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
        const parsed = JSON.parse(cleaned);
        const validated = req.schema.safeParse(parsed);
        if (!validated.success) {
          throw createLLMError('validation', 'response did not match schema', {
            rawText,
          });
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
        if (err instanceof SyntaxError) {
          // Parse failure — try once more with a corrective message.
          conversation.push(
            {
              role: 'model',
              parts: [{ text: rawText }],
            },
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
        // Validation, timeout, transport — break early
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
