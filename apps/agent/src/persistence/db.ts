import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

const { Pool } = pg;

/**
 * Build pg pool config. Supabase pooler presents a self-signed cert in the
 * chain; Node's default validation rejects it. We strip sslmode from the URL
 * (because pg's connection-string parser overrides our ssl option with
 * rejectUnauthorized=true when it sees sslmode=require) and pass an explicit
 * ssl object instead — that's the combination that actually works.
 *
 * Local docker (no ssl) → ssl: false.
 * Supabase / any URL with sslmode in [require, verify-full, verify-ca] →
 * ssl: { rejectUnauthorized: <strict> }.
 */
function buildPoolConfig(connectionString: string | undefined): {
  connectionString?: string;
  ssl: false | { rejectUnauthorized: boolean };
} {
  if (!connectionString) return { ssl: false };
  const lower = connectionString.toLowerCase();
  const wantsSsl =
    lower.includes('sslmode=require') ||
    lower.includes('sslmode=verify-full') ||
    lower.includes('sslmode=verify-ca') ||
    lower.includes('supabase.co') ||
    lower.includes('supabase.com');
  if (!wantsSsl) {
    return { connectionString, ssl: false };
  }
  const strict = lower.includes('sslmode=verify-full') || lower.includes('sslmode=verify-ca');
  // Strip the sslmode parameter so pg doesn't override our explicit ssl option.
  const cleaned = connectionString.replace(/[?&]sslmode=[^&]*/g, (_match, _g0) => {
    return _match.startsWith('?') ? '?' : '&';
  });
  // Fix the case where stripping leaves a trailing ? or &
  const finalUrl = cleaned.replace(/[?&]$/, '');
  return {
    connectionString: finalUrl,
    ssl: { rejectUnauthorized: strict },
  };
}

const poolCfg = buildPoolConfig(config.DATABASE_URL);

export const pool = new Pool({
  connectionString: poolCfg.connectionString,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: poolCfg.ssl,
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error');
});

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values as unknown[]);
}
