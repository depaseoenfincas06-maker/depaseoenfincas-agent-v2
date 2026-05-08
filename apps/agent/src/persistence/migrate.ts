/**
 * Minimal migration runner. Reads .sql files from ./migrations,
 * applies them in lexicographic order, tracks applied ones in
 * _migrations. Intentionally tiny — no framework dependency.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTx } from './db.js';
import { logger } from '../observability/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureRegistry() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listFiles(): Promise<string[]> {
  const files = await fs.readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function listApplied(): Promise<Set<string>> {
  const r = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  return new Set(r.rows.map((row) => row.name));
}

export async function up(): Promise<{ appliedCount: number; total: number }> {
  await ensureRegistry();
  const files = await listFiles();
  const applied = await listApplied();
  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ file }, 'applying migration');
    await withTx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    });
    appliedCount += 1;
  }
  logger.info({ appliedCount, total: files.length }, 'migrations done');
  return { appliedCount, total: files.length };
}

async function down() {
  // Rollback strategy: we keep migrations strictly forward-only.
  // For a single-step rollback in dev, drop the database and re-run.
  // Implementing reversible migrations adds maintenance cost we don't need yet.
  throw new Error(
    'Rollback not implemented. For local dev: docker compose down -v && docker compose up -d && pnpm db:migrate.',
  );
}

// Only run as CLI when this file is the direct entry point (NOT when
// imported by server/index.ts for boot-time auto-migration).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate.ts') ||
  process.argv[1]?.endsWith('migrate.js');

if (isMainModule) {
  const cmd = process.argv[2] ?? 'up';
  (async () => {
    try {
      if (cmd === 'up') await up();
      else if (cmd === 'down') await down();
      else throw new Error(`Unknown command: ${cmd}`);
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'migration failed');
      await pool.end();
      process.exit(1);
    }
  })();
}
