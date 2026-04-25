/**
 * Admin / dashboard API. Read-mostly endpoints exposing what the agent did.
 * No auth on this prototype — gate behind a reverse proxy + basic auth or a
 * VPN in deployment.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { refreshInventory } from '../../inventory/loader.js';

const settingsPatchSchema = z
  .object({
    tonePreset: z.string().optional(),
    toneGuidelinesExtra: z.string().nullable().optional(),
    initialMessageTemplate: z.string().nullable().optional(),
    handoffMessage: z.string().nullable().optional(),
    companyKnowledge: z.record(z.unknown()).optional(),
    companyDocuments: z.array(z.record(z.unknown())).optional(),
    paymentMethods: z.record(z.unknown()).optional(),
    inventorySheetId: z.string().nullable().optional(),
    inventorySheetTab: z.string().nullable().optional(),
    followupSettings: z.record(z.unknown()).optional(),
    selectionNotificationSettings: z.record(z.unknown()).optional(),
    ownerTestMode: z.boolean().optional(),
    confirmationSettings: z.record(z.unknown()).optional(),
  })
  .strict();

export async function adminRoutes(app: FastifyInstance) {
  // ---- settings ----
  app.get('/settings', async () => {
    const r = await pool.query('SELECT * FROM agent_settings WHERE id = 1');
    return r.rows[0] ?? {};
  });

  app.put('/settings', async (req, reply) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest('invalid settings patch');
    const data = parsed.data;
    // Build a partial update: only set columns that were provided.
    const cols: string[] = [];
    const vals: unknown[] = [];
    let p = 1;
    const map: Record<string, string> = {
      tonePreset: 'tone_preset',
      toneGuidelinesExtra: 'tone_guidelines_extra',
      initialMessageTemplate: 'initial_message_template',
      handoffMessage: 'handoff_message',
      companyKnowledge: 'company_knowledge',
      companyDocuments: 'company_documents',
      paymentMethods: 'payment_methods',
      inventorySheetId: 'inventory_sheet_id',
      inventorySheetTab: 'inventory_sheet_tab',
      followupSettings: 'followup_settings',
      selectionNotificationSettings: 'selection_notification_settings',
      ownerTestMode: 'owner_test_mode',
      confirmationSettings: 'confirmation_settings',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (!col) continue;
      const isJson =
        typeof v === 'object' && v !== null && (Array.isArray(v) || k.endsWith('Knowledge') || k.endsWith('Documents') || k.endsWith('Methods') || k.endsWith('Settings'));
      if (isJson) {
        cols.push(`${col} = $${p}::jsonb`);
        vals.push(JSON.stringify(v));
      } else {
        cols.push(`${col} = $${p}`);
        vals.push(v);
      }
      p += 1;
    }
    if (cols.length === 0) return reply.send({ ok: true, updated: 0 });
    await pool.query(`UPDATE agent_settings SET ${cols.join(', ')} WHERE id = 1`, vals);
    const r = await pool.query('SELECT * FROM agent_settings WHERE id = 1');
    return r.rows[0];
  });

  // ---- conversations ----
  app.get('/conversations', async (req) => {
    const q = req.query as { stage?: string; limit?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
    const where = q.stage ? 'WHERE current_stage = $1' : '';
    const args = q.stage ? [q.stage, limit] : [limit];
    const sql = `
      SELECT wa_id, client_name, current_stage, search_criteria, shown_fincas,
             selected_finca, agente_activo, hitl_reason, updated_at
        FROM conversations
        ${where}
        ORDER BY updated_at DESC
        LIMIT $${args.length}
    `;
    const r = await pool.query(sql, args);
    return r.rows;
  });

  app.get('/conversations/:waId', async (req, reply) => {
    const { waId } = req.params as { waId: string };
    const conv = await pool.query('SELECT * FROM conversations WHERE wa_id = $1', [waId]);
    if (conv.rows.length === 0) return reply.notFound();
    const messages = await pool.query(
      `SELECT id, direction, message_type, content, media_url, media_mime_type,
              transcription_status, detected_intent, state_at_time, agent_used, created_at
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        LIMIT 500`,
      [waId],
    );
    const traces = await pool.query(
      `SELECT id, stage_before, stage_after, intent, outbound_count, status, silence_reason,
              duration_ms, created_at
         FROM traces
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [waId],
    );
    return { conversation: conv.rows[0], messages: messages.rows, traces: traces.rows };
  });

  // ---- kanban view ----
  app.get('/kanban', async () => {
    const r = await pool.query(`
      SELECT current_stage, wa_id, client_name, search_criteria, selected_finca,
             agente_activo, updated_at
        FROM conversations
        ORDER BY updated_at DESC
        LIMIT 500
    `);
    const groups: Record<string, typeof r.rows> = {
      QUALIFYING: [],
      OFFERING: [],
      VERIFYING_AVAILABILITY: [],
      CONFIRMING_RESERVATION: [],
      HITL: [],
    };
    for (const row of r.rows) {
      const g = groups[row.current_stage as keyof typeof groups];
      if (g) g.push(row);
    }
    return groups;
  });

  // ---- traces ----
  app.get('/traces', async (req) => {
    const q = req.query as { status?: string; limit?: string; conversationId?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
    const where: string[] = [];
    const args: unknown[] = [];
    let p = 1;
    if (q.status) {
      where.push(`status = $${p++}`);
      args.push(q.status);
    }
    if (q.conversationId) {
      where.push(`conversation_id = $${p++}`);
      args.push(q.conversationId);
    }
    args.push(limit);
    const sql = `
      SELECT id, conversation_id, stage_before, stage_after, intent, outbound_count,
             status, silence_reason, duration_ms, created_at
        FROM traces
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${p}
    `;
    const r = await pool.query(sql, args);
    return r.rows;
  });

  app.get('/traces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trace = await pool.query('SELECT * FROM traces WHERE id = $1', [id]);
    if (trace.rows.length === 0) return reply.notFound();
    const turns = await pool.query(
      `SELECT * FROM agent_turns WHERE trace_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return { trace: trace.rows[0], turns: turns.rows };
  });

  // ---- fallback events ----
  app.get('/fallback-events', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
    const r = await pool.query(
      `SELECT id, conversation_id, trace_id, reason, context, created_at
         FROM fallback_events
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  });

  // ---- inventory ----
  app.post('/inventory/refresh', async () => {
    const count = await refreshInventory();
    return { ok: true, count };
  });

  // ---- health ----
  app.get('/health-detailed', async () => {
    const dbOk = await pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    const pendingInbox = await pool
      .query("SELECT COUNT(*)::int AS n FROM message_inbox WHERE status IN ('queued','processing')")
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => -1);
    const fallbacks24h = await pool
      .query("SELECT COUNT(*)::int AS n FROM fallback_events WHERE created_at > now() - interval '24 hours'")
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => -1);
    const silent24h = await pool
      .query("SELECT COUNT(*)::int AS n FROM traces WHERE status='silent' AND created_at > now() - interval '24 hours'")
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => -1);
    return {
      db: dbOk,
      pendingInbox,
      fallbacks24h,
      silent24h,
      ts: new Date().toISOString(),
    };
  });
}
