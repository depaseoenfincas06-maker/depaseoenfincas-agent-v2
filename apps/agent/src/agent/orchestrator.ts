/**
 * Orchestrator: the single entry point used by the message worker. Given a
 * persisted inbound message, runs the full turn:
 *
 *   1. Hydrate conversation context + settings + recent history
 *   2. If the inbound is an empty audio → fallback message + return
 *   3. Route to QA / HITL / stage handler
 *   4. Apply always-respond guard
 *   5. Persist outbound + update conversation state
 *
 * Errors in stage handlers don't crash the worker — they emit a fallback
 * outbound and finalize the trace as 'fallback'.
 */
import type {
  Channel,
  ConversationContext,
  Stage,
  Intent,
  OutboundMessage,
  TranscriptionStatus,
} from '@depf/shared';
import { applyDeterministicRules, applyLLMRouter } from './router.js';
import { getStageHandler, qaStage } from './stages/index.js';
import type { StageInput, AgentSettingsView } from './stages/types.js';
import { Trace } from '../observability/tracer.js';
import { applyAlwaysRespondGuard } from '../observability/fallback-guard.js';
import { logger } from '../observability/logger.js';
import { withTx, query } from '../persistence/db.js';
import { getChannel } from '../channels/index.js';

interface InboundEnvelope {
  channel: Channel;
  conversationId: string;
  externalMessageId?: string;
  text: string | null;
  transcriptionStatus: TranscriptionStatus;
  mediaUrl?: string;
  mediaMimeType?: string;
  mediaDurationSec?: number;
  inboxId: string;
}

export interface OrchestratorResult {
  traceId: string;
  status: 'ok' | 'silent' | 'fallback' | 'error';
  outboundCount: number;
}

export class Orchestrator {
  async run(envelope: InboundEnvelope): Promise<OrchestratorResult> {
    const log = logger.child({
      conversationId: envelope.conversationId,
      inboxId: envelope.inboxId,
    });

    // 1. Persist inbound as a message row + load context
    const inboundMessage = await this.persistInbound(envelope);
    const conversation = await this.loadConversation(envelope.conversationId);
    const settings = await this.loadSettings();
    const recent = await this.loadRecent(envelope.conversationId);

    const trace = await Trace.start({
      conversationId: envelope.conversationId,
      inboundMessageId: inboundMessage.id,
      stageBefore: conversation.currentStage,
    });

    try {
      return await this.runInner(envelope, conversation, settings, recent, trace, log);
    } catch (err) {
      log.error({ err }, 'orchestrator run failed catastrophically — emitting fallback');
      // Last-resort fallback: even if everything broke, emit a message and
      // record the failure. We never let an inbound disappear into the void.
      try {
        const guard = await applyAlwaysRespondGuard({
          trace,
          conversationId: envelope.conversationId,
          channel: envelope.channel,
          outbound: [],
          silenceReason: null,
          fallbackReason: 'STAGE_HANDLER_THREW',
          context: {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5) : undefined,
          },
        });
        await this.deliverOutbound(envelope.conversationId, guard.outbound, trace.id).catch(() => {});
        await trace.finalize({
          stageAfter: conversation.currentStage,
          intent: null,
          outboundCount: guard.outbound.length,
          status: 'fallback',
          errorDetail: { message: err instanceof Error ? err.message : String(err) },
        });
        return {
          traceId: trace.id,
          status: 'fallback',
          outboundCount: guard.outbound.length,
        };
      } catch (innerErr) {
        // If even the fallback path fails, mark the trace as error and rethrow
        // so BullMQ records it.
        log.error({ err: innerErr }, 'fallback path itself failed');
        await trace
          .finalize({
            stageAfter: conversation.currentStage,
            intent: null,
            outboundCount: 0,
            status: 'error',
            errorDetail: {
              message: err instanceof Error ? err.message : String(err),
              fallbackError: innerErr instanceof Error ? innerErr.message : String(innerErr),
            },
          })
          .catch(() => {});
        throw err;
      }
    }
  }

  private async runInner(
    envelope: InboundEnvelope,
    conversation: ConversationContext,
    settings: AgentSettingsView,
    recent: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>,
    trace: Trace,
    log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ): Promise<OrchestratorResult> {
    // Short-circuit: HITL active → silence (per-conversation)
    if (!conversation.agenteActivo) {
      await trace.finalize({
        stageAfter: conversation.currentStage,
        intent: null,
        outboundCount: 0,
        status: 'silent',
        silenceReason: 'HITL_ACTIVE',
      });
      return { traceId: trace.id, status: 'silent', outboundCount: 0 };
    }

    // Short-circuit: global bot disabled (master switch from settings)
    if (settings.globalBotEnabled === false) {
      log.info({}, 'global bot disabled — silencing this turn');
      await trace.finalize({
        stageAfter: conversation.currentStage,
        intent: null,
        outboundCount: 0,
        status: 'silent',
        silenceReason: 'GLOBAL_BOT_DISABLED',
      });
      return { traceId: trace.id, status: 'silent', outboundCount: 0 };
    }

    // Short-circuit: empty audio transcription → fallback
    if (envelope.transcriptionStatus === 'empty' || envelope.transcriptionStatus === 'failed') {
      const guard = await applyAlwaysRespondGuard({
        trace,
        conversationId: envelope.conversationId,
        channel: envelope.channel,
        outbound: [],
        silenceReason: null,
        fallbackReason: 'TRANSCRIPTION_EMPTY',
        context: { transcriptionStatus: envelope.transcriptionStatus },
      });
      await this.deliverOutbound(envelope.conversationId, guard.outbound, trace.id);
      await trace.finalize({
        stageAfter: conversation.currentStage,
        intent: null,
        outboundCount: guard.outbound.length,
        status: 'fallback',
      });
      return { traceId: trace.id, status: 'fallback', outboundCount: guard.outbound.length };
    }

    const userText = (envelope.text ?? '').trim();
    if (!userText) {
      // No content at all (and not audio) — should never happen but we guard.
      const guard = await applyAlwaysRespondGuard({
        trace,
        conversationId: envelope.conversationId,
        channel: envelope.channel,
        outbound: [],
        silenceReason: null,
        fallbackReason: 'NO_OUTBOUND_NO_REASON',
        context: { reason: 'empty inbound text' },
      });
      await this.deliverOutbound(envelope.conversationId, guard.outbound, trace.id);
      await trace.finalize({
        stageAfter: conversation.currentStage,
        intent: null,
        outboundCount: guard.outbound.length,
        status: 'fallback',
      });
      return { traceId: trace.id, status: 'fallback', outboundCount: guard.outbound.length };
    }

    // 2. Route — deterministic regex first, LLM classifier as fallback.
    const ruleRoute = applyDeterministicRules(userText);
    const route =
      ruleRoute ??
      (await applyLLMRouter({
        text: userText,
        stage: conversation.currentStage,
        conversation,
        trace,
      }));

    let outbound: OutboundMessage[] = [];
    let nextStage: Stage = conversation.currentStage;
    let intent: Intent | null = null;
    let extractedData: Record<string, unknown> = {};
    let fallbackReason: 'STAGE_HANDLER_THREW' | 'TOOL_LOOP_EXHAUSTED' | undefined;

    try {
      const stageInput: StageInput = {
        userText,
        recentMessages: recent,
        conversation,
        settings,
        trace,
      };
      let decision;
      if (route.destination === 'hitl') {
        decision = await getStageHandler('HITL').handle(stageInput);
      } else if (route.destination === 'qa') {
        log.info({ reason: route.reason, confidence: route.confidence }, 'routed to QA');
        decision = await qaStage.handle(stageInput);
      } else {
        decision = await this.runStage(conversation.currentStage, stageInput);
      }
      intent = decision.intent;
      nextStage = decision.nextStage;
      extractedData = decision.extractedData ?? {};
      outbound = decision.outbound.map(
        (m: OutboundMessage): OutboundMessage => ({ ...m, channel: envelope.channel }),
      );
    } catch (err) {
      log.error({ err }, 'stage handler threw');
      fallbackReason = 'STAGE_HANDLER_THREW';
      await trace.recordTurn({
        stage: conversation.currentStage,
        model: 'n/a',
        prompt: { userText },
        response: null,
        toolsCalled: [],
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        latencyMs: null,
        status: 'error',
        errorDetail: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    // 3. Always-respond guard
    const guard = await applyAlwaysRespondGuard({
      trace,
      conversationId: envelope.conversationId,
      channel: envelope.channel,
      outbound,
      silenceReason: null,
      ...(fallbackReason ? { fallbackReason } : {}),
      context: { intent, nextStage },
    });

    // 4. Deliver outbound
    await this.deliverOutbound(envelope.conversationId, guard.outbound, trace.id);

    // 5. Persist conversation update — merge extracted_data into search_criteria
    // and reservation as appropriate.
    await this.persistConversationUpdate(envelope.conversationId, nextStage, extractedData);

    await trace.finalize({
      stageAfter: nextStage,
      intent,
      outboundCount: guard.outbound.length,
      status: guard.status === 'silent' ? 'silent' : guard.status === 'fallback' ? 'fallback' : 'ok',
    });

    return {
      traceId: trace.id,
      status: guard.status,
      outboundCount: guard.outbound.length,
    };
  }

  private async runStage(stage: Stage, input: StageInput) {
    const handler = getStageHandler(stage);
    return handler.handle(input);
  }

  private async persistInbound(envelope: InboundEnvelope): Promise<{ id: string }> {
    // Pick a message_type that satisfies the messages_text_or_media constraint.
    // - real text → TEXT
    // - audio with successful transcription → AUDIO (text in content)
    // - audio with empty/failed transcription → AUDIO_UNTRANSCRIBED (no content)
    let messageType: string;
    if (envelope.transcriptionStatus === 'empty' || envelope.transcriptionStatus === 'failed') {
      messageType = 'AUDIO_UNTRANSCRIBED';
    } else if (envelope.mediaUrl) {
      messageType = 'AUDIO';
    } else {
      messageType = 'TEXT';
    }
    const r = await query<{ id: string }>(
      `INSERT INTO messages
         (conversation_id, external_message_id, direction, message_type, content,
          media_url, media_mime_type, media_duration_sec, transcription_status, state_at_time)
         SELECT $1, $2, 'inbound', $3, $4, $5, $6, $7, $8, current_stage
           FROM conversations WHERE wa_id = $1
         RETURNING id`,
      [
        envelope.conversationId,
        envelope.externalMessageId ?? null,
        messageType,
        envelope.text ?? null,
        envelope.mediaUrl ?? null,
        envelope.mediaMimeType ?? null,
        envelope.mediaDurationSec ?? null,
        envelope.transcriptionStatus,
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('failed to persist inbound message');
    return { id };
  }

  private async loadConversation(conversationId: string): Promise<ConversationContext> {
    const r = await query<{
      wa_id: string;
      chatwoot_conversation_id: number | null;
      client_name: string | null;
      current_stage: Stage;
      search_criteria: ConversationContext['searchCriteria'];
      shown_fincas: string[];
      selected_finca: string | null;
      owner_response: ConversationContext['ownerResponse'] | null;
      pricing: ConversationContext['pricing'] | null;
      reservation: ConversationContext['reservation'] | null;
      agente_activo: boolean;
      hitl_reason: string | null;
      extras: Record<string, unknown>;
    }>(
      `SELECT * FROM conversations WHERE wa_id = $1`,
      [conversationId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`conversation not found: ${conversationId}`);
    return {
      waId: row.wa_id,
      chatwootConversationId: row.chatwoot_conversation_id ?? undefined,
      clientName: row.client_name ?? undefined,
      currentStage: row.current_stage,
      searchCriteria: row.search_criteria ?? {},
      shownFincas: row.shown_fincas ?? [],
      selectedFinca: row.selected_finca ?? undefined,
      ownerResponse: row.owner_response ?? undefined,
      pricing: row.pricing ?? undefined,
      reservation: row.reservation ?? undefined,
      agenteActivo: row.agente_activo,
      hitlReason: row.hitl_reason ?? undefined,
      extras: row.extras ?? {},
    };
  }

  private async loadSettings(): Promise<AgentSettingsView> {
    const r = await query<{
      tone_preset: string;
      tone_guidelines_extra: string | null;
      initial_message_template: string | null;
      handoff_message: string | null;
      company_knowledge: unknown;
      company_documents: Array<{ name: string; url?: string; topics?: string[] }>;
      payment_methods: unknown;
      // v1-parity columns (added by migration 0002)
      prompt_addenda: Record<string, string | null> | null;
      coverage_zones: string | null;
      public_app_base_url: string | null;
      max_properties_to_show: number | null;
      global_bot_enabled: boolean | null;
      owner_test_mode: boolean | null;
      owner_contact_override: string | null;
      inventory_sheet_id: string | null;
      inventory_sheet_tab: string | null;
    }>(`SELECT * FROM agent_settings WHERE id = 1`);
    const row = r.rows[0];
    if (!row) throw new Error('agent_settings row not found');
    return {
      tonePreset: row.tone_preset,
      toneGuidelinesExtra: row.tone_guidelines_extra ?? undefined,
      initialMessageTemplate: row.initial_message_template ?? undefined,
      handoffMessage: row.handoff_message ?? undefined,
      companyKnowledge: (row.company_knowledge ?? {}) as Record<string, unknown> | string,
      companyDocuments: row.company_documents ?? [],
      paymentMethods: row.payment_methods ?? {},
      promptAddenda: (row.prompt_addenda ?? {}) as AgentSettingsView['promptAddenda'],
      coverageZones: row.coverage_zones,
      publicAppBaseUrl: row.public_app_base_url,
      maxPropertiesToShow: row.max_properties_to_show ?? 3,
      globalBotEnabled: row.global_bot_enabled ?? true,
      ownerTestMode: row.owner_test_mode ?? false,
      ownerContactOverride: row.owner_contact_override,
      inventorySheetId: row.inventory_sheet_id,
      inventorySheetTab: row.inventory_sheet_tab,
    };
  }

  private async loadRecent(
    conversationId: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>> {
    const r = await query<{ direction: string; content: string | null; created_at: string }>(
      `SELECT direction, content, created_at
         FROM messages
        WHERE conversation_id = $1 AND content IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 12`,
      [conversationId],
    );
    return r.rows.map((row) => ({
      role: row.direction === 'inbound' ? 'user' : 'assistant',
      content: row.content ?? '',
      createdAt: row.created_at,
    }));
  }

  private async deliverOutbound(
    conversationId: string,
    outbound: OutboundMessage[],
    traceId: string,
  ): Promise<void> {
    for (const msg of outbound) {
      const adapter = getChannel(msg.channel);
      try {
        const sendResult = await adapter.send(conversationId, msg);
        await withTx(async (client) => {
          await client.query(
            `INSERT INTO messages
               (conversation_id, external_message_id, direction, message_type, content)
               VALUES ($1, $2, 'outbound', 'TEXT', $3)`,
            [conversationId, sendResult.externalMessageId ?? null, msg.text ?? ''],
          );
          await client.query(
            `INSERT INTO message_outbox
               (trace_id, conversation_id, channel, payload, status, sent_at, external_message_id)
               VALUES ($1, $2, $3, $4::jsonb, 'sent', now(), $5)`,
            [
              traceId,
              conversationId,
              msg.channel,
              JSON.stringify(msg),
              sendResult.externalMessageId ?? null,
            ],
          );
        });
      } catch (err) {
        logger.error({ err, conversationId }, 'channel send failed');
        await query(
          `INSERT INTO message_outbox
             (trace_id, conversation_id, channel, payload, status, last_error)
             VALUES ($1, $2, $3, $4::jsonb, 'failed', $5)`,
          [
            traceId,
            conversationId,
            msg.channel,
            JSON.stringify(msg),
            err instanceof Error ? err.message : String(err),
          ],
        );
        throw err;
      }
    }
  }

  private async persistConversationUpdate(
    conversationId: string,
    nextStage: Stage,
    extractedData: Record<string, unknown>,
  ): Promise<void> {
    // Split extracted_data into searchCriteria fields vs reservation fields.
    const criteriaKeys = new Set([
      'fechaInicio',
      'fechaFin',
      'personas',
      'zona',
      'ciudad',
      'presupuestoMax',
      'tipoEvento',
      'amenidades',
      'mascotas',
    ]);
    const reservationKeys = new Set([
      'nombreCompleto',
      'tipoDocumento',
      'numeroDocumento',
      'celular',
      'email',
      'direccion',
    ]);
    const criteriaPatch: Record<string, unknown> = {};
    const reservationPatch: Record<string, unknown> = {};
    let chosenFincaId: string | undefined;
    for (const [k, v] of Object.entries(extractedData)) {
      if (v == null) continue;
      if (criteriaKeys.has(k)) criteriaPatch[k] = v;
      else if (reservationKeys.has(k)) reservationPatch[k] = v;
      else if (k === 'finca_elegida_id' || k === 'fincaId' || k === 'selectedFinca') {
        chosenFincaId = String(v);
      }
    }

    await query(
      `UPDATE conversations
          SET current_stage = $2,
              search_criteria = COALESCE(search_criteria, '{}'::jsonb) || $3::jsonb,
              reservation = COALESCE(reservation, '{}'::jsonb) || $4::jsonb,
              selected_finca = COALESCE($5, selected_finca),
              shown_fincas = CASE
                WHEN $5 IS NOT NULL AND NOT ($5 = ANY(shown_fincas))
                  THEN array_append(shown_fincas, $5)
                ELSE shown_fincas
              END,
              agente_activo = CASE WHEN $2 = 'HITL' THEN false ELSE agente_activo END
        WHERE wa_id = $1`,
      [
        conversationId,
        nextStage,
        JSON.stringify(criteriaPatch),
        JSON.stringify(reservationPatch),
        chosenFincaId ?? null,
      ],
    );
  }
}

export const orchestrator = new Orchestrator();
