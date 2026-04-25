import { Queue, QueueEvents } from 'bullmq';
import { redis } from './connection.js';
import { logger } from '../observability/logger.js';

export const MESSAGE_QUEUE_NAME = 'depf:messages';

export interface MessageJob {
  /** message_inbox.id */
  inboxId: string;
  /** conversations.wa_id — used for grouping */
  conversationId: string;
  /** when the message was first received */
  enqueuedAt: string;
}

export const messageQueue = new Queue<MessageJob>(MESSAGE_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
  },
});

export const messageQueueEvents = new QueueEvents(MESSAGE_QUEUE_NAME, { connection: redis });

messageQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, 'message job failed');
});

export async function enqueueMessageJob(job: MessageJob): Promise<void> {
  await messageQueue.add(`msg:${job.conversationId}`, job, {
    jobId: job.inboxId, // dedupe by inbox row
    /**
     * Group jobs by conversationId. With BullMQ, true conversation-level
     * serialization is enforced inside the worker via Postgres advisory locks
     * (see ./conversation-lock.ts). The group hint just gives BullMQ a chance
     * to keep them on the same worker for cache locality.
     */
  });
}
