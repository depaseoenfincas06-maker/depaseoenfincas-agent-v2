/**
 * Eval runner. Loads JSONL cases, runs each through the orchestrator with a
 * fresh in-memory conversation, asserts expectations, prints a report, exits
 * non-zero on failure.
 *
 * Usage: pnpm evals
 *   or:  pnpm evals -- tests/evals/silences.jsonl
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool } from '../persistence/db.js';
import { orchestrator } from '../agent/orchestrator.js';
import { logger } from '../observability/logger.js';
import type { EvalCase, EvalResult } from './types.js';
import type { Stage } from '@depf/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadCases(file: string): Promise<EvalCase[]> {
  const abs = path.isAbsolute(file)
    ? file
    : path.resolve(__dirname, '../../tests/evals', file);
  const text = await fs.readFile(abs, 'utf8');
  const cases: EvalCase[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    try {
      cases.push(JSON.parse(trimmed));
    } catch (err) {
      logger.warn({ line: trimmed.slice(0, 80), err }, 'skip invalid eval line');
    }
  }
  return cases;
}

async function listEvalFiles(): Promise<string[]> {
  const dir = path.resolve(__dirname, '../../tests/evals');
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function setupConversation(c: EvalCase): Promise<string> {
  const waId = `eval-${c.id}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO conversations (wa_id, current_stage, search_criteria, shown_fincas, selected_finca, agente_activo)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (wa_id) DO UPDATE SET
         current_stage = EXCLUDED.current_stage,
         search_criteria = EXCLUDED.search_criteria,
         shown_fincas = EXCLUDED.shown_fincas,
         selected_finca = EXCLUDED.selected_finca,
         agente_activo = EXCLUDED.agente_activo`,
    [
      waId,
      (c.context?.stage as Stage) ?? 'QUALIFYING',
      JSON.stringify(c.context?.searchCriteria ?? {}),
      c.context?.shownFincas ?? [],
      c.context?.selectedFinca ?? null,
      c.context?.agenteActivo ?? true,
    ],
  );
  return waId;
}

async function runCase(c: EvalCase): Promise<EvalResult> {
  const failures: string[] = [];
  let waId = '';
  try {
    waId = await setupConversation(c);
    const inboxId = await pool.query<{ id: string }>(
      `INSERT INTO message_inbox (conversation_id, payload, status)
         VALUES ($1, $2::jsonb, 'processing')
         RETURNING id`,
      [
        waId,
        JSON.stringify({
          channel: 'simulator',
          conversationId: waId,
          text: c.input.kind === 'text' ? c.input.text : null,
          transcriptionStatus: c.input.kind === 'audio_empty' ? 'empty' : c.input.kind === 'audio_failed' ? 'failed' : null,
        }),
      ],
    );

    const result = await orchestrator.run({
      channel: 'simulator',
      conversationId: waId,
      text: c.input.kind === 'text' ? c.input.text : null,
      transcriptionStatus: c.input.kind === 'audio_empty' ? 'empty' : c.input.kind === 'audio_failed' ? 'failed' : null,
      inboxId: inboxId.rows[0]!.id,
    });

    // Read back the trace + outbound messages for assertions
    const trace = await pool.query<{
      status: string;
      intent: string | null;
      stage_after: string | null;
      outbound_count: number;
      duration_ms: number | null;
    }>(
      `SELECT status, intent, stage_after, outbound_count, duration_ms
         FROM traces WHERE id = $1`,
      [result.traceId],
    );
    const t = trace.rows[0]!;
    const outboundMsgs = await pool.query<{ content: string | null }>(
      `SELECT content FROM messages
         WHERE conversation_id = $1 AND direction = 'outbound'
         ORDER BY created_at ASC`,
      [waId],
    );
    const outboundTexts = outboundMsgs.rows.map((r) => r.content ?? '').filter(Boolean);
    const outboundJoined = outboundTexts.join(' ').toLowerCase();

    // Assertions
    const exp = c.expect;
    if (exp.status && !exp.status.includes(t.status as 'ok' | 'silent' | 'fallback' | 'error')) {
      failures.push(`expected status in [${exp.status.join(',')}], got ${t.status}`);
    }
    const minOut = exp.minOutbounds ?? 1;
    if (t.outbound_count < minOut) {
      failures.push(`expected ≥${minOut} outbound, got ${t.outbound_count}`);
    }
    if (exp.intent && t.intent && !exp.intent.includes(t.intent)) {
      failures.push(`expected intent in [${exp.intent.join(',')}], got ${t.intent}`);
    }
    if (exp.stageAfter && t.stage_after && !exp.stageAfter.includes(t.stage_after)) {
      failures.push(`expected stage_after in [${exp.stageAfter.join(',')}], got ${t.stage_after}`);
    }
    if (exp.outboundContainsAll) {
      for (const phrase of exp.outboundContainsAll) {
        if (!outboundJoined.includes(phrase.toLowerCase())) {
          failures.push(`outbound must contain "${phrase}"`);
        }
      }
    }
    if (exp.outboundContainsNone) {
      for (const phrase of exp.outboundContainsNone) {
        if (outboundJoined.includes(phrase.toLowerCase())) {
          failures.push(`outbound must NOT contain "${phrase}"`);
        }
      }
    }

    return {
      case: c,
      passed: failures.length === 0,
      failures,
      trace: {
        status: t.status,
        intent: t.intent,
        stageAfter: t.stage_after,
        outboundCount: t.outbound_count,
        outboundTexts,
        durationMs: t.duration_ms,
      },
    };
  } catch (err) {
    return {
      case: c,
      passed: false,
      failures: [`threw: ${err instanceof Error ? err.message : String(err)}`],
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    };
  } finally {
    if (waId) {
      await pool.query('DELETE FROM conversations WHERE wa_id = $1', [waId]).catch(() => {});
    }
  }
}

async function main() {
  const arg = process.argv[2];
  const files = arg ? [arg] : await listEvalFiles();
  if (files.length === 0) {
    logger.warn('no eval files found in tests/evals');
    process.exit(0);
  }

  const allResults: EvalResult[] = [];
  for (const file of files) {
    const cases = await loadCases(file);
    logger.info({ file, n: cases.length }, 'loaded eval file');
    for (const c of cases) {
      const r = await runCase(c);
      allResults.push(r);
      const tag = r.passed ? '✓' : '✗';
      const meta = r.trace
        ? `${r.trace.status} ${r.trace.intent ?? ''} → ${r.trace.stageAfter ?? '?'} (${r.trace.outboundCount} out, ${r.trace.durationMs ?? '?'}ms)`
        : (r.error ?? '');
      // eslint-disable-next-line no-console
      console.log(`${tag} ${c.id} — ${meta}`);
      if (!r.passed) {
        // eslint-disable-next-line no-console
        for (const f of r.failures) console.log(`    · ${f}`);
        if (r.trace) {
          // eslint-disable-next-line no-console
          for (const t of r.trace.outboundTexts) console.log(`    > "${t.slice(0, 120)}"`);
        }
      }
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.length - passed;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${allResults.length} passed${failed ? ` — ${failed} failed` : ''}`);

  // Persist run for dashboard
  await pool.query(
    `INSERT INTO eval_runs (triggered_by, total, passed, failed, cases)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
    ['cli', allResults.length, passed, failed, JSON.stringify(allResults)],
  );
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  logger.error({ err }, 'eval runner crashed');
  await pool.end();
  process.exit(2);
});
