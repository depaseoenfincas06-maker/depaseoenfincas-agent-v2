/**
 * Chatwoot webhook receiver. Chatwoot sends one POST per event; we only act
 * on `message_created` with message_type=0 (incoming, from client). Anything
 * else (outgoing, private notes, conversation_created, status_changed) we
 * acknowledge with 200 and ignore.
 *
 * Normalization: Chatwoot's payload shape is verbose. We extract the fields
 * we care about, persist to message_inbox, and enqueue a BullMQ job. The
 * heavy lifting (transcription, orchestration) happens in the worker.
 *
 * Idempotency: Chatwoot may retry a webhook on 5xx. We dedupe by
 * (chatwoot_message_id) — if a row with the same external_message_id already
 * exists in messages, we skip.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { enqueueMessageJob } from '../../queue/index.js';
import { config } from '../../config.js';
import { flexibleNormalize } from './_flexible-normalize.js';

// Tolerant schema — Chatwoot evolves its payload; we want to accept what we
// recognize and ignore the rest, never reject a well-formed message.
const chatwootSenderSchema = z.object({
  identifier: z.string().nullable().optional(),
  phone_number: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
}).passthrough();

const chatwootAttachmentSchema = z.object({
  file_type: z.string().optional(),
  data_url: z.string().optional(),
  file_size: z.number().optional(),
}).passthrough();

/**
 * A single message inside the conversation.messages[] array. This is where
 * Chatwoot puts the per-message metadata (message_type, source_id=wamid,
 * sender_type, private, attachments) — NOT at the top level. That mismatch
 * is what made our earlier normalizer skip every real event.
 */
const chatwootMessageSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    content: z.string().nullable().optional(),
    content_type: z.string().optional(),
    message_type: z.union([z.number(), z.string()]).optional(),
    source_id: z.string().nullable().optional(),
    private: z.boolean().optional(),
    sender_type: z.string().optional(), // "Contact" = client, "User" = agent
    created_at: z.union([z.number(), z.string()]).optional(),
    attachments: z.array(chatwootAttachmentSchema).optional(),
  })
  .passthrough();

/**
 * Verified against a real Chatwoot payload captured via webhook.site:
 * top-level keys are { account, content, content_type, conversation }; the
 * per-message info lives inside conversation.messages[] and the wa_id comes
 * from conversation.contact_inbox.source_id (the WhatsApp phone number).
 */
const chatwootMessagePayloadSchema = z
  .object({
    // Real Chatwoot shape
    account: z
      .object({ id: z.union([z.number(), z.string()]).optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
    content: z.string().nullable().optional(),
    content_type: z.string().optional(),
    conversation: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        inbox_id: z.union([z.number(), z.string()]).optional(),
        channel: z.string().optional(),
        can_reply: z.boolean().optional(),
        contact_inbox: z
          .object({
            source_id: z.string().nullable().optional(),
            inbox_id: z.union([z.number(), z.string()]).optional(),
          })
          .passthrough()
          .optional(),
        meta: z
          .object({
            sender: chatwootSenderSchema.optional(),
            assignee: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        messages: z.array(chatwootMessageSchema).optional(),
      })
      .passthrough()
      .optional(),

    // Legacy / alternative shape (some Chatwoot versions put fields at top level)
    event: z.string().optional(),
    id: z.union([z.number(), z.string()]).optional(),
    message_type: z.union([z.number(), z.string()]).optional(),
    source_id: z.string().nullable().optional(),
    private: z.boolean().optional(),
    sender: chatwootSenderSchema.optional(),
    sender_type: z.string().optional(),
    attachments: z.array(chatwootAttachmentSchema).optional(),
  })
  .passthrough();

type ChatwootPayload = z.infer<typeof chatwootMessagePayloadSchema>;
type ChatwootMessage = z.infer<typeof chatwootMessageSchema>;

interface NormalizedInbound {
  channel: 'chatwoot';
  conversationId: string; // wa_id (phone) — our PK
  externalMessageId: string | undefined; // wamid if available, else chatwoot id
  chatwootMessageId: string | undefined;
  chatwootConversationId: number | undefined;
  clientName: string | undefined;
  text: string | undefined;
  media:
    | {
        url: string;
        mimeType: string;
        durationSec?: number;
      }
    | undefined;
}

function isIncoming(m: { message_type?: number | string; private?: boolean; sender_type?: string }): boolean {
  if (m.private === true) return false;
  if (m.sender_type && m.sender_type !== 'Contact') return false; // agent reply, skip
  const mt = m.message_type;
  return mt === 0 || mt === '0' || mt === 'incoming';
}

/**
 * Pick the message that triggered this webhook from conversation.messages[].
 * Chatwoot includes the full conversation history; the firing message is
 * typically the last one whose content matches the top-level `content`. If
 * no match by content, fall back to the most recent inbound message.
 */
function pickTriggeringMessage(payload: ChatwootPayload): ChatwootMessage | undefined {
  const messages = payload.conversation?.messages ?? [];
  const topContent = payload.content;
  // Try by content match first (most reliable)
  if (topContent != null) {
    const match = [...messages].reverse().find((m) => m.content === topContent && isIncoming(m));
    if (match) return match;
  }
  // Fallback: most recent inbound
  return [...messages].reverse().find(isIncoming);
}

function pickWaId(payload: ChatwootPayload): string | null {
  // 1. conversation.contact_inbox.source_id (phone number, no '+', e.g. "573001234567")
  const ciSource = payload.conversation?.contact_inbox?.source_id;
  if (ciSource && /^\d+$/.test(ciSource)) return ciSource;
  // 2. conversation.meta.sender.identifier
  const metaSender = payload.conversation?.meta?.sender;
  if (metaSender?.identifier && /^\d+$/.test(metaSender.identifier)) return metaSender.identifier;
  // 3. Top-level sender.identifier (legacy format)
  const sender = payload.sender;
  if (sender?.identifier && /^\d+$/.test(sender.identifier)) return sender.identifier;
  // 4. Phone number with non-digits stripped
  const phone = metaSender?.phone_number ?? sender?.phone_number;
  if (phone) {
    const cleaned = phone.replace(/[^\d]/g, '');
    if (cleaned.length >= 10) return cleaned;
  }
  return null;
}

function pickMedia(
  attachments?: Array<z.infer<typeof chatwootAttachmentSchema>>,
): NormalizedInbound['media'] {
  const att = attachments?.[0];
  if (!att?.data_url) return undefined;
  const mimeMap: Record<string, string> = {
    audio: 'audio/ogg',
    image: 'image/jpeg',
    video: 'video/mp4',
    file: 'application/octet-stream',
  };
  const mimeType = att.file_type ? mimeMap[att.file_type] ?? 'application/octet-stream' : 'application/octet-stream';
  return { url: att.data_url, mimeType };
}

function normalize(payload: ChatwootPayload): NormalizedInbound | { skip: true; reason: string } {
  // Pick the triggering message from conversation.messages[]
  const msg = pickTriggeringMessage(payload);

  // If no inbound found in messages array, also accept top-level legacy shape
  // where {message_type, source_id, sender, content, private} are at root.
  const legacyTopIsInbound = payload.message_type != null && isIncoming(payload);

  if (!msg && !legacyTopIsInbound) {
    return {
      skip: true,
      reason: `no inbound message — top message_type=${payload.message_type ?? '?'} private=${payload.private ?? '?'} messages_count=${payload.conversation?.messages?.length ?? 0}`,
    };
  }

  const waId = pickWaId(payload);
  if (!waId) {
    return { skip: true, reason: 'cannot resolve wa_id (contact_inbox.source_id, meta.sender, or sender)' };
  }

  // Content / wamid / chatwoot id come from the picked message OR top-level legacy
  const content = msg?.content ?? payload.content ?? null;
  const sourceId = msg?.source_id ?? payload.source_id;
  const wamid = sourceId && sourceId.startsWith('wamid.') ? sourceId : undefined;
  const chatwootMessageId = msg?.id != null ? String(msg.id) : payload.id != null ? String(payload.id) : undefined;
  const conversationId = payload.conversation?.id != null ? Number(payload.conversation.id) : undefined;
  const clientName = payload.conversation?.meta?.sender?.name ?? payload.sender?.name ?? undefined;
  const media = pickMedia(msg?.attachments) ?? pickMedia(payload.attachments);

  return {
    channel: 'chatwoot',
    conversationId: waId,
    externalMessageId: wamid ?? chatwootMessageId,
    chatwootMessageId,
    chatwootConversationId: conversationId,
    clientName,
    text: content ?? undefined,
    media,
  };
}

// Test-only re-exports so unit tests can hit the pure functions without
// spinning up a Fastify instance.
export const __test_normalize = normalize;
export const __test_schema = chatwootMessagePayloadSchema;

/**
 * Auth check for the Chatwoot webhook. Chatwoot does NOT send the secret
 * literally as a header — it signs each payload with HMAC-SHA256 using the
 * configured Secret and sends the result in `x-chatwoot-signature: sha256=…`.
 * We accept three modes:
 *
 *   1. HMAC verification (real Chatwoot deliveries):
 *      computed = HMAC-SHA256(WEBHOOK_SHARED_SECRET, raw_body)
 *      compare to x-chatwoot-signature, constant-time
 *
 *   2. Literal `x-webhook-secret` header (manual curl tests, simulators,
 *      legacy callers). Convenient for ops debugging.
 *
 *   3. If WEBHOOK_SHARED_SECRET is unset, accept any caller (open mode —
 *      relies on URL secrecy alone). Useful for early dev / smoke tests.
 *
 * Originally we ONLY checked mode 2, which silently 401'd every real
 * Chatwoot delivery and led to Chatwoot disabling the webhook entirely.
 */
function verifyAuth(req: FastifyRequest): { ok: true } | { ok: false; reason: string } {
  if (!config.WEBHOOK_SHARED_SECRET) return { ok: true };

  const literal = req.headers['x-webhook-secret'];
  if (typeof literal === 'string' && literal === config.WEBHOOK_SHARED_SECRET) {
    return { ok: true };
  }

  const sig = req.headers['x-chatwoot-signature'];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  if (typeof sigStr === 'string') {
    const m = sigStr.match(/^sha256=([a-f0-9]+)$/i);
    if (m) {
      const raw = (req as unknown as { rawBody?: string }).rawBody;
      if (typeof raw === 'string' && raw.length > 0) {
        const computed = createHmac('sha256', config.WEBHOOK_SHARED_SECRET).update(raw).digest('hex');
        const a = Buffer.from(m[1]!.toLowerCase(), 'hex');
        const b = Buffer.from(computed.toLowerCase(), 'hex');
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return { ok: true };
        }
        return { ok: false, reason: 'x-chatwoot-signature HMAC mismatch' };
      }
      return { ok: false, reason: 'cannot verify HMAC: rawBody not captured' };
    }
  }

  return {
    ok: false,
    reason: 'no valid auth: x-webhook-secret literal mismatch and x-chatwoot-signature missing/invalid',
  };
}

export async function chatwootWebhookRoutes(app: FastifyInstance) {
  app.post('/chatwoot', async (req, reply) => {
    const auth = verifyAuth(req);
    if (!auth.ok) {
      req.log.warn({ reason: auth.reason }, 'chatwoot webhook auth failed');
      return reply.unauthorized(auth.reason);
    }

    const parsed = chatwootMessagePayloadSchema.safeParse(req.body);
    let normalized: NormalizedInbound | { skip: true; reason: string } = { skip: true, reason: 'not parsed yet' };

    // Step 1: try the strict Chatwoot-aware normalizer
    if (parsed.success) {
      normalized = normalize(parsed.data);
    } else {
      req.log.warn({ issues: parsed.error.issues.slice(0, 5) }, 'strict schema parse failed — will try flexible');
    }

    // Step 2: if strict skipped, fall back to the flexible heuristic. This
    // makes us accept payloads from new Chatwoot versions, Meta directly,
    // custom integrations — anything that has a phone + text somewhere.
    if ('skip' in normalized) {
      const flex = flexibleNormalize(req.body);
      if ('skip' in flex) {
        req.log.info(
          { strictReason: normalized.reason, flexReason: flex.reason, found: flex.found },
          'webhook ignored — neither strict nor flexible could normalize',
        );
        return reply.send({ ok: true, ignored: true, reason: `strict=${normalized.reason}; flex=${flex.reason}` });
      }
      req.log.info({ strictReason: normalized.reason, waId: flex.waId }, 'flexible normalizer rescued the payload');
      normalized = {
        channel: 'chatwoot',
        conversationId: flex.waId,
        externalMessageId: flex.externalMessageId,
        chatwootMessageId: flex.chatwootMessageId,
        chatwootConversationId: flex.chatwootConversationId,
        clientName: flex.clientName,
        text: flex.text ?? undefined,
        media: flex.media,
      };
    }

    // Idempotency: if we already have a message with this external_message_id,
    // skip (Chatwoot retried).
    if (normalized.externalMessageId) {
      const existing = await pool.query(
        `SELECT id FROM messages WHERE external_message_id = $1 LIMIT 1`,
        [normalized.externalMessageId],
      );
      if (existing.rows.length > 0) {
        req.log.info({ externalMessageId: normalized.externalMessageId }, 'duplicate chatwoot webhook — already processed');
        return reply.send({ ok: true, duplicate: true });
      }
    }

    // Upsert conversation with chatwoot_conversation_id link
    await pool.query(
      `INSERT INTO conversations (wa_id, chatwoot_conversation_id, client_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (wa_id) DO UPDATE SET
           chatwoot_conversation_id = COALESCE(EXCLUDED.chatwoot_conversation_id, conversations.chatwoot_conversation_id),
           client_name = COALESCE(EXCLUDED.client_name, conversations.client_name)`,
      [normalized.conversationId, normalized.chatwootConversationId ?? null, normalized.clientName ?? null],
    );

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO message_inbox (conversation_id, payload)
         VALUES ($1, $2::jsonb)
         RETURNING id`,
      [normalized.conversationId, JSON.stringify(normalized)],
    );
    const inboxId = inserted.rows[0]?.id;
    if (!inboxId) throw new Error('failed to persist chatwoot inbox row');

    await enqueueMessageJob({
      inboxId,
      conversationId: normalized.conversationId,
      enqueuedAt: new Date().toISOString(),
    });

    return reply.send({ ok: true, inboxId });
  });
}
