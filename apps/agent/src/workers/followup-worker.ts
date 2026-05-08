/**
 * Follow-up worker — direct port of v1's `Agregar follow on` + scheduled
 * cron pattern. Periodically scans the follow_on table for rows whose
 * `scheduled_for` has passed and the conversation is still active, then
 * sends the configured message via the customer's channel.
 *
 * Window: only fires between 08:00–22:00 in Bogotá (UTC-5). Outside the
 * window the row stays 'pendiente' and we'll retry on the next tick.
 *
 * Cancellation: a row is 'cancelada' when the customer replies before the
 * scheduled time. v1 cancelled in `Cancel pending follow on` SQL — we do
 * that via a hook in the orchestrator (TODO: wire on inbound).
 *
 * Run cadence: setInterval every 60 seconds is enough; the queries are
 * cheap and a 1-min granularity matches v1's cron.
 */
import { pool } from '../persistence/db.js';
import { logger } from '../observability/logger.js';
import { getChannel } from '../channels/index.js';
import type { Channel } from '@depf/shared';

const TICK_MS = 60_000;
const BOGOTA_OFFSET_HOURS = -5;
const ALLOWED_HOUR_START = 8;
const ALLOWED_HOUR_END = 22;

function bogotaHourNow(): number {
  const utc = new Date().getUTCHours();
  return (utc + BOGOTA_OFFSET_HOURS + 24) % 24;
}

function withinSendWindow(): boolean {
  const h = bogotaHourNow();
  return h >= ALLOWED_HOUR_START && h < ALLOWED_HOUR_END;
}

interface PendingFollowup {
  id: string;
  conversation_id: string;
  message: string;
}

interface ConversationRow {
  agente_activo: boolean;
  followup_enabled: boolean;
  chatwoot_conversation_id: number | null;
}

async function processOne(row: PendingFollowup): Promise<void> {
  const conv = await pool.query<ConversationRow>(
    `SELECT agente_activo, followup_enabled, chatwoot_conversation_id
       FROM conversations WHERE wa_id = $1`,
    [row.conversation_id],
  );
  const c = conv.rows[0];
  if (!c) {
    logger.warn({ id: row.id }, 'follow-up: conversation gone, skipping');
    await pool.query(
      `UPDATE follow_on SET status='cancelada', cancel_reason='conversation_deleted', cancelled_at=now() WHERE id=$1`,
      [row.id],
    );
    return;
  }
  if (!c.agente_activo || !c.followup_enabled) {
    logger.info(
      { id: row.id, conversationId: row.conversation_id, agente_activo: c.agente_activo, followup_enabled: c.followup_enabled },
      'follow-up: bot paused for this conversation, cancelling',
    );
    await pool.query(
      `UPDATE follow_on SET status='cancelada', cancel_reason='agente_pausado', cancelled_at=now() WHERE id=$1`,
      [row.id],
    );
    return;
  }

  // Default channel for follow-ups is whatever channel the conversation is
  // using. We assume Chatwoot in production. If you have a simulator-only
  // conversation, this still goes to chatwoot since we don't store channel
  // per-conversation; that's a known limitation.
  const channel: Channel = 'chatwoot';
  const adapter = getChannel(channel);
  try {
    const result = await adapter.send(
      {
        waId: row.conversation_id,
        ...(c.chatwoot_conversation_id != null
          ? { chatwootConversationId: Number(c.chatwoot_conversation_id) }
          : {}),
      },
      { channel, type: 'text', text: row.message },
    );
    if (result.delivered) {
      await pool.query(
        `UPDATE follow_on SET status='sent', sent_at=now() WHERE id=$1`,
        [row.id],
      );
      // Bump the conversation's followup_count + last_message_from.
      await pool.query(
        `UPDATE conversations
            SET followup_count = COALESCE(followup_count, 0) + 1,
                last_message_from = 'AGENT'
          WHERE wa_id = $1`,
        [row.conversation_id],
      );
      logger.info({ id: row.id, conversationId: row.conversation_id }, 'follow-up sent');
    } else {
      await pool.query(
        `UPDATE follow_on SET status='failed', cancel_reason=$2 WHERE id=$1`,
        [row.id, result.failureReason ?? 'send returned not delivered'],
      );
      logger.warn(
        { id: row.id, reason: result.failureReason },
        'follow-up send returned not delivered',
      );
    }
  } catch (err) {
    await pool.query(
      `UPDATE follow_on SET status='failed', cancel_reason=$2 WHERE id=$1`,
      [row.id, err instanceof Error ? err.message : String(err)],
    );
    logger.error({ err, id: row.id }, 'follow-up send threw');
  }
}

export async function tick(): Promise<{ processed: number; skipped: boolean }> {
  if (!withinSendWindow()) {
    return { processed: 0, skipped: true };
  }
  // Lock & claim a small batch per tick so concurrent worker instances
  // don't race on the same row.
  const claimed = await pool.query<PendingFollowup>(
    `WITH claimed AS (
       SELECT id FROM follow_on
        WHERE status='pendiente' AND scheduled_for <= now()
        ORDER BY scheduled_for ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
     )
     UPDATE follow_on SET status='processing'
       WHERE id IN (SELECT id FROM claimed)
       RETURNING id, conversation_id, message`,
  );
  for (const row of claimed.rows) {
    await processOne(row);
  }
  return { processed: claimed.rows.length, skipped: false };
}

let timer: NodeJS.Timeout | null = null;

export function startFollowupWorker(): void {
  if (timer) return;
  logger.info({ tickMs: TICK_MS }, 'follow-up worker starting');
  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'follow-up tick threw'));
  }, TICK_MS);
}

export function stopFollowupWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
