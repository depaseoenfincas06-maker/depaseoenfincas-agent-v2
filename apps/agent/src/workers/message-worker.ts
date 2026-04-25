/**
 * BullMQ worker that consumes the message queue. For each job:
 *   1. Acquire conversation-level advisory lock (serializes per conversation)
 *   2. Load conversation context + the inbox row
 *   3. Run the orchestrator (TODO — Phase 2)
 *   4. Mark inbox row as done/failed
 *
 * For Phase 0 this is a stub that logs and marks the row as done so we can
 * verify wiring end-to-end before plugging in the orchestrator.
 */
import { Worker } from 'bullmq';
import { redis } from '../queue/connection.js';
import { MESSAGE_QUEUE_NAME, type MessageJob } from '../queue/index.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { lockConversation } from '../persistence/conversation-lock.js';
import { pool } from '../persistence/db.js';
import { orchestrator } from '../agent/orchestrator.js';
import { transcribe, buildDomainPrompt } from '../media/transcribe.js';
import { downloadMedia } from '../media/download.js';
import { loadFincas } from '../inventory/loader.js';
import type { Channel, TranscriptionStatus } from '@depf/shared';

interface InboundPayload {
  channel: Channel;
  conversationId: string;
  externalMessageId?: string;
  waId?: string;
  clientName?: string;
  text?: string;
  media?: { url: string; mimeType: string; filename?: string; durationSec?: number };
  transcriptionStatus?: TranscriptionStatus;
}

async function processJob(job: { id?: string; data: MessageJob }) {
  const { inboxId, conversationId } = job.data;
  const log = logger.child({ jobId: job.id, inboxId, conversationId });
  log.info('processing message job');

  const lock = await lockConversation(conversationId);
  try {
    const inboxRow = await pool.query<{ payload: InboundPayload }>(
      `UPDATE message_inbox
          SET status='processing', attempts = attempts + 1
        WHERE id = $1
        RETURNING payload`,
      [inboxId],
    );
    const payload = inboxRow.rows[0]?.payload;
    if (!payload) throw new Error(`inbox row missing: ${inboxId}`);

    // Audio handling: if the inbound has media that looks like audio AND
    // text wasn't already provided, download and transcribe it BEFORE
    // entering the orchestrator. This way the agent only ever sees text
    // (or an explicit empty/failed flag) — never a half-baked audio.
    let text = payload.text ?? null;
    let transcriptionStatus: TranscriptionStatus = payload.transcriptionStatus ?? null;
    if (payload.media?.url && (!text || text.trim().length === 0) && /audio|video/.test(payload.media.mimeType)) {
      try {
        const media = await downloadMedia(payload.media.url, payload.media.mimeType);
        const fincas = await loadFincas().catch(() => []);
        const domainPrompt = buildDomainPrompt({
          fincaCodes: fincas.map((f) => f.fincaId),
        });
        const tr = await transcribe(
          {
            buffer: media.buffer,
            mimeType: media.mimeType,
            filename: payload.media.filename ?? media.filename,
            durationSec: payload.media.durationSec ?? null,
          },
          { domainPrompt, language: 'es' },
        );
        transcriptionStatus = tr.status;
        if (tr.ok) text = tr.text;
        log.info(
          {
            transcriptionStatus,
            attempts: tr.attempts.map((a) => ({ model: a.model, ok: a.ok, latencyMs: a.latencyMs })),
          },
          'transcription complete',
        );
      } catch (err) {
        log.error({ err }, 'transcription pipeline failed');
        transcriptionStatus = 'failed';
      }
    }

    const result = await orchestrator.run({
      channel: payload.channel,
      conversationId,
      externalMessageId: payload.externalMessageId,
      text,
      transcriptionStatus,
      mediaUrl: payload.media?.url,
      mediaMimeType: payload.media?.mimeType,
      mediaDurationSec: payload.media?.durationSec,
      inboxId,
    });

    await pool.query(
      `UPDATE message_inbox SET status='done', processed_at=now() WHERE id=$1`,
      [inboxId],
    );
    log.info({ result }, 'message job done');
  } catch (err) {
    log.error({ err }, 'message job failed');
    await pool
      .query(
        `UPDATE message_inbox SET status='failed', last_error=$2 WHERE id=$1`,
        [inboxId, err instanceof Error ? err.message : String(err)],
      )
      .catch(() => {});
    throw err;
  } finally {
    await lock.release();
  }
}

export const worker = new Worker<MessageJob>(MESSAGE_QUEUE_NAME, processJob, {
  connection: redis,
  concurrency: config.QUEUE_CONCURRENCY,
});

worker.on('ready', () => logger.info('message worker ready'));
worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err }, 'worker job failed'),
);
worker.on('error', (err) => logger.error({ err }, 'worker error'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, 'shutting down worker');
    await worker.close();
    await pool.end();
    process.exit(0);
  });
}
