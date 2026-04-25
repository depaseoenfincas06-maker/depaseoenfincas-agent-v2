/**
 * Webhook receivers — one path per channel. Each handler:
 *   1. Validates payload (zod)
 *   2. Persists message_inbox row
 *   3. Enqueues BullMQ job
 *   4. Returns 200 quickly
 *
 * Heavy work happens in the worker. We avoid doing anything that could
 * lose the message between receiving and persisting.
 */
import type { FastifyInstance } from 'fastify';
import { inboundWebhookSchema } from '@depf/shared';
import { pool } from '../../persistence/db.js';
import { enqueueMessageJob } from '../../queue/index.js';
import { config } from '../../config.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Generic inbound — accepts already-normalized payloads (used by simulator
  // and by tests). For Chatwoot/Meta we'd add channel-specific routes that
  // normalize first.
  app.post('/inbound', async (req, reply) => {
    const sharedSecret = req.headers['x-webhook-secret'];
    if (config.WEBHOOK_SHARED_SECRET && sharedSecret !== config.WEBHOOK_SHARED_SECRET) {
      return reply.unauthorized('invalid webhook secret');
    }

    const parsed = inboundWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'invalid webhook payload');
      return reply.badRequest('invalid payload');
    }

    const payload = parsed.data;
    const conversationId = payload.waId ?? payload.conversationId;

    // Ensure conversation row exists (FK target)
    await pool.query(
      `INSERT INTO conversations (wa_id, client_name)
         VALUES ($1, $2)
         ON CONFLICT (wa_id) DO NOTHING`,
      [conversationId, payload.clientName ?? null],
    );

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO message_inbox (conversation_id, payload)
         VALUES ($1, $2::jsonb)
         RETURNING id`,
      [conversationId, JSON.stringify(payload)],
    );
    const inboxId = inserted.rows[0]?.id;
    if (!inboxId) throw new Error('failed to persist inbox row');

    await enqueueMessageJob({
      inboxId,
      conversationId,
      enqueuedAt: new Date().toISOString(),
    });

    return reply.send({ ok: true, inboxId });
  });

  // Health & inspect: helpful in dev to see what's queued
  app.get('/inbox/:conversationId', async (req) => {
    const { conversationId } = req.params as { conversationId: string };
    const r = await pool.query(
      `SELECT id, status, attempts, last_error, created_at, processed_at
         FROM message_inbox
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [conversationId],
    );
    return r.rows;
  });
}
