/**
 * Conversation-level mutex using Postgres advisory locks. We hash the
 * conversation_id (text) into a 32-bit int and use pg_try_advisory_lock,
 * giving us fast, lease-free locks scoped to the connection.
 *
 * Critical for the "no concurrent runs on the same conversation" guarantee
 * that prevents context bleed when multiple inbound messages arrive close
 * together.
 */
import crypto from 'node:crypto';
import { pool } from './db.js';

function hashKey(conversationId: string): number {
  // pg_advisory_lock takes a bigint; we use the first 4 bytes of sha1 as int.
  const h = crypto.createHash('sha1').update(conversationId).digest();
  // Read as signed int32 to fit in pg's bigint comfortably.
  return h.readInt32BE(0);
}

export interface LockHandle {
  release(): Promise<void>;
}

/**
 * Acquire a session-scoped advisory lock for this conversationId.
 * Uses pg_advisory_lock (blocking). The handle MUST be released or the
 * connection must be terminated.
 */
export async function lockConversation(conversationId: string): Promise<LockHandle> {
  const key = hashKey(conversationId);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    return {
      async release() {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Try to acquire without blocking. Returns null if the lock is busy.
 */
export async function tryLockConversation(conversationId: string): Promise<LockHandle | null> {
  const key = hashKey(conversationId);
  const client = await pool.connect();
  try {
    const r = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [key],
    );
    if (!r.rows[0]?.pg_try_advisory_lock) {
      client.release();
      return null;
    }
    return {
      async release() {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}
