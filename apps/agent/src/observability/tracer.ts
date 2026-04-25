/**
 * Trace = one inbound→outbound cycle. We open a trace at the start of an
 * orchestrator run, attach agent_turns + outbound counts as it progresses,
 * and finalize at the end. If the process dies mid-way, the trace stays in
 * status='error' which is queryable from the dashboard.
 */
import type { PoolClient } from 'pg';
import type {
  AgentTurnStatus,
  Stage,
  Intent,
  TraceStatus,
  SilenceReason,
  ToolCall,
} from '@depf/shared';
import { pool, withTx } from '../persistence/db.js';

export interface TraceInit {
  conversationId: string;
  inboundMessageId: string | null;
  stageBefore: Stage | null;
}

export interface AgentTurnRecord {
  stage: Stage | 'router' | 'classifier';
  model: string;
  prompt: unknown;
  response: unknown;
  toolsCalled: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: AgentTurnStatus;
  errorDetail?: Record<string, unknown>;
}

export interface FinalizeArgs {
  stageAfter: Stage | null;
  intent: Intent | null;
  outboundCount: number;
  status: TraceStatus;
  silenceReason?: SilenceReason | null;
  errorDetail?: Record<string, unknown> | null;
}

export class Trace {
  readonly id: string;
  readonly startedAt: number;
  private finalized = false;

  constructor(id: string, _conversationId: string) {
    this.id = id;
    this.startedAt = Date.now();
  }

  static async start(init: TraceInit): Promise<Trace> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO traces (conversation_id, inbound_message_id, stage_before, status)
         VALUES ($1, $2, $3, 'ok')
         RETURNING id`,
      [init.conversationId, init.inboundMessageId, init.stageBefore],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('failed to insert trace');
    return new Trace(id, init.conversationId);
  }

  async recordTurn(turn: AgentTurnRecord, client?: PoolClient): Promise<void> {
    const exec = client ?? pool;
    await exec.query(
      `INSERT INTO agent_turns
         (trace_id, stage, model, prompt, response, tools_called, tokens_in, tokens_out, cost_usd, latency_ms, status, error_detail)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        this.id,
        turn.stage,
        turn.model,
        JSON.stringify(turn.prompt ?? null),
        JSON.stringify(turn.response ?? null),
        JSON.stringify(turn.toolsCalled ?? []),
        turn.tokensIn,
        turn.tokensOut,
        turn.costUsd,
        turn.latencyMs,
        turn.status,
        JSON.stringify(turn.errorDetail ?? null),
      ],
    );
  }

  async finalize(args: FinalizeArgs): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const durationMs = Date.now() - this.startedAt;
    await pool.query(
      `UPDATE traces SET
         stage_after=$2,
         intent=$3,
         outbound_count=$4,
         status=$5,
         silence_reason=$6,
         duration_ms=$7,
         error_detail=$8::jsonb
       WHERE id=$1`,
      [
        this.id,
        args.stageAfter,
        args.intent,
        args.outboundCount,
        args.status,
        args.silenceReason ?? null,
        durationMs,
        JSON.stringify(args.errorDetail ?? null),
      ],
    );
  }

  /**
   * Convenience: record a fallback event tied to this trace.
   */
  async recordFallback(
    conversationId: string,
    reason: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO fallback_events (conversation_id, trace_id, reason, context)
           VALUES ($1, $2, $3, $4::jsonb)`,
        [conversationId, this.id, reason, JSON.stringify(context)],
      );
    });
  }
}
