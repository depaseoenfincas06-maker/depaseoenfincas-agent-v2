import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is apps/agent/src — repo root is 3 levels up
loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
loadDotenv({ path: path.resolve(__dirname, '../.env'), quiet: true });
loadDotenv({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Render (and most PaaS) inject a $PORT env var the service must bind to.
   * Locally we use AGENT_HTTP_PORT (default 3200). PORT takes precedence.
   */
  PORT: z.coerce.number().int().positive().optional(),
  AGENT_HTTP_PORT: z.coerce.number().int().positive().default(3200),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),

  LLM_PROVIDER: z.enum(['gemini', 'anthropic']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('gpt-4o-transcribe'),
  OPENAI_TRANSCRIPTION_FALLBACK_MODEL: z.string().default('whisper-1'),

  CHATWOOT_BASE_URL: z.string().url().optional(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive().default(1),
  CHATWOOT_API_TOKEN: z.string().optional(),
  CHATWOOT_INBOX_ID: z.coerce.number().int().positive().optional(),
  /**
   * Chatwoot inbox ID for the property OWNERS' inbox. When a webhook fires
   * with this inbox_id, the message is treated as an owner reply (parsed
   * for sí/no availability and routed to handleOwnerInbound) instead of as
   * a customer inbound. Optional — if unset, owner-inbox routing is off.
   */
  CHATWOOT_OWNER_INBOX_ID: z.coerce.number().int().positive().optional(),
  /**
   * HMAC secret for signing reservation-confirmation URLs. Falls back to
   * WEBHOOK_SHARED_SECRET if unset (good enough for early dev — set a
   * dedicated value in production).
   */
  PDF_HMAC_SECRET: z.string().optional(),
  /**
   * Public-facing base URL for /api/reservation-confirmation.pdf — should
   * point at the same Render service. Used to build customer-shareable
   * links. Falls back to the conversation's settings.publicAppBaseUrl.
   */
  PUBLIC_APP_BASE_URL: z.string().url().optional(),

  /**
   * Client-facing WhatsApp number (the main agent). Currently +57 310 5639334.
   * Used to: receive inbound messages, show typing indicator, send media.
   */
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  /**
   * Owner-facing WhatsApp number, used to verify finca availability with
   * property owners. Currently +1 205-583-7827 (formerly Kapso main).
   */
  WHATSAPP_OWNER_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  INVENTORY_SHEET_DOCUMENT_ID: z.string().optional(),
  INVENTORY_SHEET_TAB_NAME: z.string().default('fincas_inventory_ajustada_real'),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  WEBHOOK_SHARED_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.format());
    throw new Error('Invalid environment configuration');
  }
  cached = parsed.data;
  return cached;
}

export const config = loadConfig();
