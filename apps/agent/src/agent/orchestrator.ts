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
import { mergeCriteriaWithCurrent } from './criteria.js';
import type { StageInput, AgentSettingsView } from './stages/types.js';
import { Trace } from '../observability/tracer.js';
import { applyAlwaysRespondGuard } from '../observability/fallback-guard.js';
import { logger } from '../observability/logger.js';
import { withTx, query } from '../persistence/db.js';
import { getChannel } from '../channels/index.js';
import { chatwootChannel } from '../channels/chatwoot.js';
import { sendSelectionNotifications, parseRecipients } from './selection-notifications.js';
import { sendOwnerReservationRequest } from './owner-reservation.js';
import { getFincaById } from '../inventory/loader.js';

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

/**
 * Substitute {client_name} placeholder (and a couple of common variants) in
 * the initial message template. If we don't have a name we just drop the
 * substitution gracefully — the rest of the template still reads fine.
 */
export function renderInitialGreeting(template: string, clientName: string | null): string {
  const name = clientName?.trim() ?? '';
  // Replace the placeholder. Spaces around the placeholder collapse if name
  // is empty (so "Hola{client_name}, ..." stays clean).
  let out = template
    .replace(/\{client_name\}/g, name ? ` ${name}` : '')
    .replace(/\{clientName\}/g, name ? ` ${name}` : '')
    .replace(/\{name\}/g, name);
  // Collapse any accidental double-space introduced by an empty substitution.
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out;
}

export interface OrchestratorResult {
  traceId: string;
  status: 'ok' | 'silent' | 'fallback' | 'error';
  outboundCount: number;
}

/**
 * Deterministic prechecks (v1 parity):
 *   - owner_response.disponible === true  → jump to CONFIRMING_RESERVATION
 *   - owner_response.disponible === false → bounce back to OFFERING (the
 *     bot then proposes adjusting criteria / picking another finca)
 *   - owner_response not set yet, current stage VERIFYING_AVAILABILITY →
 *     stay in VERIFYING (let the LLM handle the wait politely)
 *
 * Returns null when no forcing is needed. The orchestrator applies the
 * forced stage BEFORE running the router/QA/stage handler so the right
 * prompt + flow runs even if the customer's text was vague.
 */
export function computePrecheckForcedStage(c: ConversationContext): Stage | null {
  const owner = c.ownerResponse;
  if (!owner || owner.disponible == null) return null;

  if (owner.disponible === true) {
    // Only force forward if we're not already in or past CONFIRMING.
    if (c.currentStage === 'OFFERING' || c.currentStage === 'VERIFYING_AVAILABILITY') {
      return 'CONFIRMING_RESERVATION';
    }
    return null;
  }
  // disponible === false → owner says no. Reset to OFFERING so the bot
  // can present alternatives.
  if (c.currentStage === 'VERIFYING_AVAILABILITY' || c.currentStage === 'CONFIRMING_RESERVATION') {
    return 'OFFERING';
  }
  return null;
}

/** Business stages an auto-loop is allowed to land on. HITL is excluded —
 *  if a hop produces next_stage=HITL we want to deliver the handoff outbound
 *  immediately, not re-run. */
const AUTO_LOOP_STAGES: Set<Stage> = new Set([
  'QUALIFYING',
  'OFFERING',
  'VERIFYING_AVAILABILITY',
  'CONFIRMING_RESERVATION',
]);

/** Combine two extracted_data patches, with the later one winning on
 *  conflicting scalar keys but unioning array keys (zona/ciudad/amenidades).
 *  Used inside the auto-loop to accumulate criteria across hops. */
function mergeExtractedData(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v == null) continue;
    if (Array.isArray(v) && Array.isArray(out[k])) {
      // Union of arrays, dedup by lower-cased string compare.
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const item of [...(out[k] as unknown[]), ...v]) {
        const key = String(item).toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      out[k] = merged;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Detect the v1 RESET command. Case-insensitive, trim-tolerant; only the
 *  exact word "RESET" (no other tokens). v1 used the same exact-match rule
 *  so the customer can't accidentally trigger it with a sentence like
 *  "did you reset?". */
export function isResetCommand(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.trim().toUpperCase() === 'RESET';
}

const RESET_REPLY = 'Listo. Reinicié nuestra conversación. Cuéntame, ¿en qué te puedo ayudar?';

export class Orchestrator {
  async run(envelope: InboundEnvelope): Promise<OrchestratorResult> {
    const log = logger.child({
      conversationId: envelope.conversationId,
      inboxId: envelope.inboxId,
    });

    // RESET command short-circuit — runs BEFORE persistInbound so we don't
    // pollute the messages table with the RESET command itself, and BEFORE
    // any agente_activo / global-bot-disabled gates so the customer can
    // always recover even if the bot was paused. v1 parity.
    if (isResetCommand(envelope.text)) {
      return this.handleReset(envelope, log);
    }

    // 1. Persist inbound as a message row + load context. Also cancel any
    // pending follow-ups for this conversation — the customer just replied,
    // so the queued reminder is no longer needed (v1 parity: "Cancel
    // pending follow on" SQL).
    const inboundMessage = await this.persistInbound(envelope);
    await query(
      `UPDATE follow_on SET status='cancelada', cancel_reason='client_replied', cancelled_at=now()
        WHERE conversation_id = $1 AND status = 'pendiente'`,
      [envelope.conversationId],
    ).catch((err) => log.warn({ err }, 'cancel pending follow-ups failed (non-fatal)'));
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
    conversationArg: ConversationContext,
    settings: AgentSettingsView,
    recent: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>,
    trace: Trace,
    log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ): Promise<OrchestratorResult> {
    let conversation = conversationArg;
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

    // Short-circuit: first inbound on a brand-new conversation → send the
    // configured initial_message_template (verbatim, with {client_name}
    // substitution). This matches v1 behavior where the agent always opens
    // with Santiago's structured "Excelente día!🤩🌅..." greeting before
    // engaging in real qualification. The user's first message content is
    // already persisted; QUALIFYING will see it on the NEXT inbound when
    // they reply with the requested fields.
    //
    // Detection: recent.length === 1 means the only message in history is
    // the inbound we just persisted. If they had ever messaged before, recent
    // would have ≥2 (inbound + our prior reply).
    if (
      recent.length === 1 &&
      settings.initialMessageTemplate &&
      settings.initialMessageTemplate.trim().length > 0
    ) {
      const greeting = renderInitialGreeting(
        settings.initialMessageTemplate,
        conversation.clientName ?? null,
      );
      const greetingOutbound: OutboundMessage = {
        channel: envelope.channel,
        type: 'text',
        text: greeting,
      };
      await this.deliverOutbound(envelope.conversationId, [greetingOutbound], trace.id);
      // Record a synthetic agent_turn so the dashboard shows what happened.
      await trace.recordTurn({
        stage: 'QUALIFYING',
        model: 'template',
        prompt: { kind: 'initial_message_template', template: settings.initialMessageTemplate },
        response: { text: greeting },
        toolsCalled: [],
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        latencyMs: null,
        status: 'ok',
      });
      await this.persistConversationUpdate(envelope.conversationId, conversation.currentStage, {});
      await trace.finalize({
        stageAfter: conversation.currentStage,
        intent: 'GREETING',
        outboundCount: 1,
        status: 'ok',
      });
      log.info({ template: 'initial_message_template' }, 'first-inbound greeting sent');
      return { traceId: trace.id, status: 'ok', outboundCount: 1 };
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

    // 2a. Deterministic prechecks (v1 parity): if owner_response was just
    // set since the last turn, force the appropriate stage transition
    // BEFORE running the router/QA/stage handler. This implements
    // "Compute deterministic prechecks" from v1.
    const precheckForcedStage = computePrecheckForcedStage(conversation);
    if (precheckForcedStage && precheckForcedStage !== conversation.currentStage) {
      log.info(
        { from: conversation.currentStage, to: precheckForcedStage, reason: 'owner_response' },
        'precheck: forcing stage transition',
      );
      conversation = { ...conversation, currentStage: precheckForcedStage };
    }

    // 2b. Route — deterministic regex first, LLM classifier as fallback.
    const ruleRoute = applyDeterministicRules(userText);
    const route =
      ruleRoute ??
      (await applyLLMRouter({
        text: userText,
        stage: conversation.currentStage,
        conversation,
        trace,
      }));

    // Auto-loop: when the LLM moves us from QUALIFYING → OFFERING (or any
    // business-state transition), v1 re-runs the next stage immediately
    // before replying to the user. That lets the same inbound first save
    // criteria via QUALIFYING and then immediately produce the property
    // cards via OFFERING — without forcing the customer to send another
    // message just to see what they qualified for. Cap at 3 hops to match
    // v1's max_iterations.
    let outbound: OutboundMessage[] = [];
    let nextStage: Stage = conversation.currentStage;
    let intent: Intent | null = null;
    let extractedData: Record<string, unknown> = {};
    let fallbackReason: 'STAGE_HANDLER_THREW' | 'TOOL_LOOP_EXHAUSTED' | undefined;
    let runningConversation = conversation;
    let routeForThisHop: typeof route | null = route;

    const MAX_AUTO_LOOP_HOPS = 3;
    for (let hop = 0; hop < MAX_AUTO_LOOP_HOPS; hop += 1) {
      try {
        const stageInput: StageInput = {
          userText,
          recentMessages: recent,
          conversation: runningConversation,
          settings,
          trace,
        };
        let decision;
        // QA / HITL routing only applies on the FIRST hop (when the user's
        // own text is the input). Subsequent auto-loop hops always go to
        // the new stage handler — we already decided "this is a business
        // state transition" and shouldn't second-guess that with another
        // QA classifier pass.
        if (hop === 0 && routeForThisHop?.destination === 'hitl') {
          decision = await getStageHandler('HITL').handle(stageInput);
        } else if (hop === 0 && routeForThisHop?.destination === 'qa') {
          log.info(
            { reason: routeForThisHop.reason, confidence: routeForThisHop.confidence },
            'routed to QA',
          );
          decision = await qaStage.handle(stageInput);
        } else {
          decision = await this.runStage(runningConversation.currentStage, stageInput);
        }
        intent = decision.intent;
        nextStage = decision.nextStage;
        extractedData = mergeExtractedData(extractedData, decision.extractedData ?? {});
        // Each hop's outbound is concatenated. Most hops produce nothing
        // (e.g. QUALIFYING just saves criteria → blank reply); the final
        // OFFERING hop emits the cards.
        outbound = outbound.concat(
          decision.outbound.map(
            (m: OutboundMessage): OutboundMessage => ({ ...m, channel: envelope.channel }),
          ),
        );
      } catch (err) {
        log.error({ err, hop }, 'stage handler threw');
        fallbackReason = 'STAGE_HANDLER_THREW';
        await trace.recordTurn({
          stage: runningConversation.currentStage,
          model: 'n/a',
          prompt: { userText, hop },
          response: null,
          toolsCalled: [],
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          latencyMs: null,
          status: 'error',
          errorDetail: { message: err instanceof Error ? err.message : String(err) },
        });
        break;
      }

      // Decide whether to auto-loop for another hop.
      const stageChanged = nextStage !== runningConversation.currentStage;
      const isBusinessTransition = AUTO_LOOP_STAGES.has(nextStage);
      const producedOutbound = outbound.length > 0;
      // v1 rule: only auto-loop when the LLM signals we should, by emitting
      // a stage change AND not producing customer-facing outbound (or only
      // producing the silent "ok let me look that up" preamble). When the
      // stage handler ALREADY produced outbound, we should ship it — the
      // user is waiting. When it produced nothing AND moved the state,
      // that's the signal to re-run on the new stage in the same turn.
      const shouldLoop =
        stageChanged && isBusinessTransition && !producedOutbound && hop + 1 < MAX_AUTO_LOOP_HOPS;
      if (!shouldLoop) break;

      log.info(
        { fromStage: runningConversation.currentStage, toStage: nextStage, hop },
        'auto-loop: re-running on next stage in same turn',
      );

      // Persist the criteria update from the prior hop so the next stage
      // handler sees it in `conversation.searchCriteria`.
      await this.persistConversationUpdate(
        envelope.conversationId,
        nextStage,
        extractedData,
      );
      runningConversation = await this.loadConversation(envelope.conversationId);
      routeForThisHop = null;
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

    // 5. Persist final conversation update.
    await this.persistConversationUpdate(envelope.conversationId, nextStage, extractedData);

    // 6. v1 side-effects on CLIENT_CHOSE: notify staff + ping owner. Fire-
    // and-forget — failures here log but never affect the customer turn.
    if (intent === 'CLIENT_CHOSE') {
      this.fireClientChoseSideEffects(envelope.conversationId, settings, extractedData).catch(
        (err) => log.error({ err }, 'CLIENT_CHOSE side effects failed'),
      );
    }

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

  /**
   * v1 side-effects when a customer picks a finca:
   *   - Send `staff_finca_selected_v1` template to each recipient in
   *     settings.selection_notification_recipients
   *   - Send `solicitud_reserva` template to the finca's owner_contacto
   *     (or the override, if test mode is on)
   *
   * Both are best-effort. If the inventory lookup fails or templates
   * aren't approved, we log and move on — the customer's flow is unaffected
   * since the OFFERING handler already sent its confirmation outbound
   * ("Voy a verificar disponibilidad...").
   */
  private async fireClientChoseSideEffects(
    conversationId: string,
    settings: AgentSettingsView,
    extractedData: Record<string, unknown>,
  ): Promise<void> {
    const fincaId =
      (extractedData.finca_elegida_id as string | undefined) ??
      (extractedData.fincaId as string | undefined) ??
      null;
    if (!fincaId) {
      logger.warn({ conversationId }, 'CLIENT_CHOSE without finca_elegida_id — skipping side effects');
      return;
    }
    const finca = await getFincaById(fincaId);
    if (!finca) {
      logger.warn({ conversationId, fincaId }, 'CLIENT_CHOSE: finca not found in inventory');
      return;
    }

    // Need the persisted criteria + client name for the templates.
    const ctx = await query<{
      client_name: string | null;
      search_criteria: Record<string, unknown> | null;
    }>(
      `SELECT client_name, search_criteria FROM conversations WHERE wa_id = $1`,
      [conversationId],
    );
    const clientName = ctx.rows[0]?.client_name ?? null;
    const criteria = ctx.rows[0]?.search_criteria ?? {};

    // Staff notifications (parallel — they're independent)
    const recipients = parseRecipients(settings.selectionNotificationRecipients);
    if (recipients.length > 0) {
      sendSelectionNotifications({
        clientName,
        clientWaId: conversationId,
        finca,
        recipients,
        ...(settings.staffTemplateName ? { templateName: settings.staffTemplateName } : {}),
        ...(settings.staffTemplateLanguage ? { templateLanguage: settings.staffTemplateLanguage } : {}),
      })
        .then((result) =>
          logger.info({ conversationId, fincaId, ...result }, 'staff selection notifications sent'),
        )
        .catch((err) => logger.error({ err, conversationId }, 'staff notifications threw'));
    }

    // Owner reservation request
    sendOwnerReservationRequest({
      finca,
      clientWaId: conversationId,
      ...(typeof criteria.fechaInicio === 'string' ? { fechaInicio: criteria.fechaInicio } : {}),
      ...(typeof criteria.fechaFin === 'string' ? { fechaFin: criteria.fechaFin } : {}),
      ...(typeof criteria.personas === 'number' ? { personas: criteria.personas } : {}),
      ...(settings.ownerContactOverride ? { ownerContactOverride: settings.ownerContactOverride } : {}),
      ...(settings.ownerTestMode ? { testMode: true } : {}),
      ...(settings.ownerTemplateName ? { templateName: settings.ownerTemplateName } : {}),
      ...(settings.ownerTemplateLanguage ? { templateLanguage: settings.ownerTemplateLanguage } : {}),
    })
      .then((result) =>
        logger.info({ conversationId, fincaId, ...result }, 'owner reservation request sent'),
      )
      .catch((err) => logger.error({ err, conversationId }, 'owner reservation request threw'));
  }

  /**
   * Handle the RESET command. v1 behaviour:
   *
   *   1. Look up chatwoot_conversation_id for this wa_id (we need it to
   *      send the reply AFTER the row is deleted).
   *   2. DELETE the conversations row — cascades to messages, agent_runs,
   *      message_outbox, traces, follow_on. Net effect: the next inbound
   *      starts a fresh conversation in QUALIFYING with no history.
   *   3. Send the RESET confirmation reply to the customer via Chatwoot.
   *      We use the chatwoot_conversation_id we cached BEFORE the delete.
   *
   * RESET runs before persistInbound, so the literal "RESET" message is
   * never stored. We don't write a trace either — there's no conversation
   * to attach it to and the action is fully audit-loggable from the row
   * being deleted plus the outbound message landing in the outbox of the
   * next conversation that gets created.
   */
  private async handleReset(
    envelope: InboundEnvelope,
    log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ): Promise<OrchestratorResult> {
    log.info({ event: 'reset_command' }, 'RESET received — wiping conversation');

    // 1. Resolve chatwoot_conversation_id BEFORE the delete cascade.
    const ctxRow = await query<{
      chatwoot_conversation_id: number | null;
      client_name: string | null;
    }>(
      `SELECT chatwoot_conversation_id, client_name
         FROM conversations WHERE wa_id = $1`,
      [envelope.conversationId],
    );
    const chatwootId = ctxRow.rows[0]?.chatwoot_conversation_id;
    const clientName = ctxRow.rows[0]?.client_name;

    // 2. Delete the conversation row — ON DELETE CASCADE handles dependents.
    // If there's no conversation yet (someone says RESET before any other
    // inbound), there's nothing to delete and we just send the reply.
    await query(`DELETE FROM conversations WHERE wa_id = $1`, [envelope.conversationId]);

    // 3. Send the confirmation reply. If we don't have the chatwoot id
    // (shouldn't happen in production but guard anyway), we just log and
    // return — nothing to send via.
    if (chatwootId == null) {
      log.warn({}, 'RESET: no chatwoot_conversation_id found, skipping reply send');
      return { traceId: '', status: 'silent', outboundCount: 0 };
    }

    try {
      const adapter = getChannel(envelope.channel);
      const result = await adapter.send(
        {
          waId: envelope.conversationId,
          chatwootConversationId: Number(chatwootId),
          ...(clientName ? { contactName: clientName } : {}),
        },
        { channel: envelope.channel, type: 'text', text: RESET_REPLY },
      );
      if (!result.delivered) {
        log.error(
          { reason: result.failureReason },
          'RESET reply not delivered',
        );
        return { traceId: '', status: 'fallback', outboundCount: 0 };
      }
    } catch (err) {
      log.error({ err }, 'RESET reply send threw');
      return { traceId: '', status: 'error', outboundCount: 0 };
    }

    return { traceId: '', status: 'ok', outboundCount: 1 };
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
      selection_notification_recipients: string | null;
      staff_template_name: string | null;
      staff_template_language: string | null;
      owner_template_name: string | null;
      owner_template_language: string | null;
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
      selectionNotificationRecipients: row.selection_notification_recipients,
      staffTemplateName: row.staff_template_name,
      staffTemplateLanguage: row.staff_template_language,
      ownerTemplateName: row.owner_template_name,
      ownerTemplateLanguage: row.owner_template_language,
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

  /**
   * Send each outbound through the right channel adapter, then persist the
   * result. The adapter receives a SendContext with both wa_id and the
   * Chatwoot internal numeric conversation_id so it can hit Chatwoot's
   * /conversations/{id} URL correctly. Without this, sends 404'd silently
   * (status='sent' was hardcoded — fixed below to honor sendResult.delivered).
   */
  private async deliverOutbound(
    conversationId: string,
    outbound: OutboundMessage[],
    traceId: string,
  ): Promise<void> {
    if (outbound.length === 0) return;

    // Resolve the chatwoot_conversation_id once (and contact name) before
    // delivering each message in this turn.
    const ctxRow = await query<{
      wa_id: string;
      chatwoot_conversation_id: number | null;
      client_name: string | null;
    }>(
      `SELECT wa_id, chatwoot_conversation_id, client_name
         FROM conversations WHERE wa_id = $1`,
      [conversationId],
    );
    const row = ctxRow.rows[0];
    const ctx = {
      waId: conversationId,
      chatwootConversationId:
        row?.chatwoot_conversation_id != null ? Number(row.chatwoot_conversation_id) : undefined,
      contactName: row?.client_name ?? undefined,
    };

    for (const msg of outbound) {
      const adapter = getChannel(msg.channel);
      let sendResult;
      let errMsg: string | undefined;
      try {
        sendResult = await adapter.send(ctx, msg);
      } catch (err) {
        errMsg = err instanceof Error ? err.message : String(err);
        sendResult = { delivered: false, failureReason: errMsg };
      }

      const status = sendResult.delivered ? 'sent' : 'failed';
      const lastError = sendResult.delivered ? null : (sendResult.failureReason ?? errMsg ?? 'unknown failure');

      // Persist BOTH the messages row (visible in dashboard) and the outbox
      // row (delivery audit). Even on failure, persist so we have a record.
      // For media messages we store the first attachment URL + its mime type
      // and message_type='IMAGE' / 'DOCUMENT' so the messages_text_or_media
      // constraint is satisfied even when content is empty.
      const firstAttachment = msg.attachments?.[0];
      let dbMessageType = 'TEXT';
      if (msg.type === 'image') dbMessageType = 'IMAGE';
      else if (msg.type === 'document') dbMessageType = 'DOCUMENT';
      else if (msg.type === 'media_group') {
        const mime = firstAttachment?.mimeType ?? '';
        dbMessageType = mime.startsWith('video/')
          ? 'VIDEO'
          : mime.startsWith('application/')
            ? 'DOCUMENT'
            : 'IMAGE';
      }
      const dbContent = msg.text && msg.text.length > 0 ? msg.text : null;
      const dbMediaUrl = firstAttachment?.url ?? null;
      const dbMediaMime = firstAttachment?.mimeType ?? null;

      await withTx(async (client) => {
        await client.query(
          `INSERT INTO messages
             (conversation_id, external_message_id, direction, message_type, content, media_url, media_mime_type)
             VALUES ($1, $2, 'outbound', $3, $4, $5, $6)`,
          [
            conversationId,
            sendResult.externalMessageId ?? null,
            dbMessageType,
            dbContent,
            dbMediaUrl,
            dbMediaMime,
          ],
        );
        await client.query(
          `INSERT INTO message_outbox
             (trace_id, conversation_id, channel, payload, status, sent_at, external_message_id, last_error)
             VALUES ($1, $2, $3, $4::jsonb, $5, ${sendResult.delivered ? 'now()' : 'NULL'}, $6, $7)`,
          [
            traceId,
            conversationId,
            msg.channel,
            JSON.stringify(msg),
            status,
            sendResult.externalMessageId ?? null,
            lastError,
          ],
        );
      });

      if (!sendResult.delivered) {
        logger.error(
          { conversationId, channel: msg.channel, reason: lastError },
          'outbound message NOT delivered',
        );
      }
    }
  }

  private async persistConversationUpdate(
    conversationId: string,
    nextStage: Stage,
    extractedData: Record<string, unknown>,
  ): Promise<void> {
    // Split extracted_data into searchCriteria fields vs reservation fields.
    // Allow `_remove` and `_replace` siblings for the array criteria so the
    // merger (criteria.ts) can honour "ya no importa Carmen" intents.
    const criteriaKeys = new Set([
      'fechaInicio',
      'fechaFin',
      'personas',
      'zona',
      'zona_remove',
      'zona_replace',
      'ciudad',
      'ciudad_remove',
      'ciudad_replace',
      'presupuestoMax',
      'tipoEvento',
      'amenidades',
      'amenidades_remove',
      'amenidades_replace',
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

    // Multi-turn criteria accumulation: load current, merge per v1 rules
    // (union arrays, dedup, honour _remove/_replace), persist as full JSONB.
    // This replaces the JSONB || operator approach which couldn't handle
    // dedup or removal — the user saying "y también Girardot" + the LLM
    // re-emitting "Carmen" in the next turn would otherwise lead to
    // duplicates.
    const cur = await query<{ search_criteria: Record<string, unknown> | null }>(
      `SELECT search_criteria FROM conversations WHERE wa_id = $1`,
      [conversationId],
    );
    const currentCriteria = cur.rows[0]?.search_criteria ?? {};
    const mergedCriteria = mergeCriteriaWithCurrent(currentCriteria, criteriaPatch);

    const updated = await query<{
      agente_activo: boolean;
      chatwoot_conversation_id: number | null;
    }>(
      `UPDATE conversations
          SET current_stage = $2,
              search_criteria = $3::jsonb,
              reservation = COALESCE(reservation, '{}'::jsonb) || $4::jsonb,
              selected_finca = COALESCE($5, selected_finca),
              shown_fincas = CASE
                WHEN $5 IS NOT NULL AND NOT ($5 = ANY(shown_fincas))
                  THEN array_append(shown_fincas, $5)
                ELSE shown_fincas
              END,
              agente_activo = CASE WHEN $2 = 'HITL' THEN false ELSE agente_activo END
        WHERE wa_id = $1
        RETURNING agente_activo, chatwoot_conversation_id`,
      [
        conversationId,
        nextStage,
        JSON.stringify(mergedCriteria),
        JSON.stringify(reservationPatch),
        chosenFincaId ?? null,
      ],
    );

    // ia_activa outbound sync: if we just flipped agente_activo (most
    // commonly to false on HITL), propagate to Chatwoot's custom_attributes
    // so the team sees the same state in the inbox UI. Best-effort.
    const row = updated.rows[0];
    if (row && row.chatwoot_conversation_id != null) {
      // Only patch when transitioning into HITL — that's when the local
      // value just changed. Avoid spamming Chatwoot on every business turn.
      if (nextStage === 'HITL' && row.agente_activo === false) {
        chatwootChannel
          .patchCustomAttributes(Number(row.chatwoot_conversation_id), { ia_activa: false })
          .catch((err) => logger.warn({ err }, 'ia_activa outbound sync failed'));
      }
    }
  }
}

export const orchestrator = new Orchestrator();
