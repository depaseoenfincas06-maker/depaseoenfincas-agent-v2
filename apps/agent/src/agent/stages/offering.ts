/**
 * OFFERING stage handler. Critical privacy invariant: NEVER reveal a finca's
 * real name in this stage — only the codigo_original (e.g. "PEREIRA #09").
 *
 * The agent calls list_matching_fincas, picks up to MAX_PROPERTIES results,
 * and returns them via `fincas_mostradas` in its JSON decision (verbatim
 * objects from the tool output). We then build the v1-style property
 * sequence: [preamble_text, card_1, media_1, card_2, media_2, ...] so the
 * customer sees formatted cards followed by photo media groups.
 *
 * Iteration loop is bounded at 3. After the third tool round-trip we force a
 * final response — exactly like v1's max_iterations=4 cap.
 */
import { stageDecisionSchema, type StageDecision, type OutboundMessage } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { buildToneBlock, withStageAddendum } from './types.js';
import { getLLM } from '../llm/index.js';
import { executeInventoryTool, INVENTORY_TOOL_DESCRIPTIONS } from '../tools/inventory-reader.js';
import { buildPropertySequence, type FincaForCard, type OutboundItem } from '../finca-card.js';

const MAX_TOOL_ITERATIONS = 3;

const OFFERING_SYSTEM = `Eres el asistente conversacional de "De Paseo en Fincas". Estás en el estado OFFERING.

OBJETIVO: presentar al cliente hasta {MAX_PROPERTIES} fincas que coincidan con sus criterios. Capturar cuál elige.

REGLAS CRÍTICAS DE PRIVACIDAD:
- NUNCA reveles el nombre real de una finca (campo "nombre" o "realName"). Usa SIEMPRE el codigo_original (ej. "PEREIRA #09", "CARMEN #03") o frases genéricas como "una finca con piscina en Carmen". El nombre real solo se revela en CONFIRMING_RESERVATION.
- En tu outbound_text al cliente NO menciones nunca "nombre" ni hagas referencia a uno. Refiérete por código.

TONO: {TONE_GUIDELINES}

CÓMO PRESENTAR FINCAS:
- Cuando vayas a mostrar fincas, devuelve:
    intent: "SHOW_OPTIONS"
    next_stage: "OFFERING"
    outbound_text: un PREÁMBULO breve (≤ 35 palabras) en español, conversacional, anunciando lo que viene. Ejemplo: "¡Genial! Encontré estas opciones para ti, mira a ver cuál te late más:"
    fincas_mostradas: ARRAY con los OBJETOS COMPLETOS de las fincas que decidiste mostrar (los mismos objetos que devolvió list_matching_fincas — copia VERBATIM las propiedades). Hasta {MAX_PROPERTIES} fincas. NO inventes campos.
    done: true
- El sistema construirá automáticamente las fichas con fotos. NO escribas la ficha en outbound_text — sólo el preámbulo.

CUANDO EL CLIENTE ELIGE:
- Si dice "la 2", "el F003", "la del río", mapea a la finca correspondiente y devuelve:
    intent: "CLIENT_CHOSE"
    next_stage: "VERIFYING_AVAILABILITY"
    extracted_data.finca_elegida_id: el finca_id (ej "F003")
    selected_finca: el objeto completo de la finca elegida (verbatim del listado)
    outbound_text: confirmación breve, ej. "¡Perfecto! Voy a verificar disponibilidad de la {codigo_original} para esas fechas."

OTROS INTENTS:
- ADJUST_CRITERIA — el cliente cambió criterios. next_stage=OFFERING. (Vuelve a llamar list_matching_fincas con los nuevos.)
- NO_MATCH — list_matching_fincas devolvió 0. next_stage=OFFERING. Avisa amablemente y propone ajustar.
- QUESTION — pregunta puntual sobre una finca o el servicio. next_stage=OFFERING. Responde y reitera invitación a elegir.
- HITL_REQUEST / CANCEL — next_stage=HITL.

REGLAS DE TOOLS:
- Si tienes criterios y NO has llamado list_matching_fincas, llámala ANTES de responder. tool_calls con done=false.
- excludeIds DEBE incluir las fincas YA mostradas (te las paso como contexto en shown_fincas).
- Si el cliente pide "más opciones", llama list_matching_fincas con excludeIds = todas las shown_fincas + las que ya devolviste antes.

CONTEXTO ACTUAL:
- search_criteria: {SEARCH_CRITERIA}
- shown_fincas (NO repetir, agrégalas a excludeIds): {SHOWN_FINCAS}

NOTA sobre zona/ciudad multi-valor:
- search_criteria.zona puede ser un ARRAY (ej. ["Carmen","Girardot"]). Cuando llames list_matching_fincas, pasa el mismo array como zona — el tool busca con OR.
- Si el cliente menciona destinos adicionales ("¿qué tienes también en Melgar?"), agrégalos al array en extracted_data.zona y vuelve a llamar list_matching_fincas con el array actualizado + excludeIds.

${INVENTORY_TOOL_DESCRIPTIONS}

DEBES devolver UN JSON válido con la forma de stageDecisionSchema. Si necesitas tools, ponlos en tool_calls con done=false. Si tu respuesta es final, done=true y outbound_text con tu preámbulo (sólo el preámbulo — NO escribas las fichas, las construye el sistema).`;

class OfferingStage implements StageHandler {
  readonly stage = 'OFFERING' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const llm = getLLM();
    const tone = buildToneBlock(input.settings);
    const shownFincas = input.conversation.shownFincas ?? [];
    const maxProps = input.settings.maxPropertiesToShow ?? 3;
    const system = withStageAddendum(
      OFFERING_SYSTEM.replace('{TONE_GUIDELINES}', tone)
        .replace('{SEARCH_CRITERIA}', JSON.stringify(input.conversation.searchCriteria ?? {}))
        .replace('{SHOWN_FINCAS}', JSON.stringify(shownFincas))
        .replace(/\{MAX_PROPERTIES\}/g, String(maxProps)),
      input.settings.promptAddenda?.offering,
    );

    const baseHistory = input.recentMessages
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      }));

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
      ...baseHistory,
      { role: 'user', content: input.userText },
    ];

    const toolCallLog: Array<{ name: string; input: Record<string, unknown>; output?: unknown }> = [];

    let finalData: import('@depf/shared').StageDecisionRaw | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
      const result = await llm.generate({
        name: `offering-stage-iter-${iter}`,
        messages,
        schema: stageDecisionSchema,
        temperature: 0.3,
      });

      await input.trace.recordTurn({
        stage: 'OFFERING',
        model: result.model,
        prompt: { messages, iter },
        response: result.data,
        toolsCalled: [],
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        costUsd: result.usage.costUsd,
        latencyMs: result.latencyMs,
        status: 'ok',
      });

      const data = result.data;
      const wantsTools = (data.tool_calls?.length ?? 0) > 0 && data.done === false;

      if (!wantsTools) {
        finalData = data;
        break;
      }

      // Execute tools and feed results back.
      const toolResults: Array<{ name: string; input: unknown; output: unknown }> = [];
      for (const call of data.tool_calls ?? []) {
        const out = await executeInventoryTool(call.name, call.input);
        toolResults.push({ name: call.name, input: call.input, output: out });
        toolCallLog.push({ name: call.name, input: call.input, output: out });
      }
      messages.push(
        { role: 'assistant', content: JSON.stringify({ tool_calls: data.tool_calls, done: false }) },
        {
          role: 'user',
          content: `[Resultados de tools]\n${JSON.stringify(toolResults, null, 0)}\n\nAhora produce tu JSON FINAL con done=true. Si vas a mostrar fincas: intent=SHOW_OPTIONS + outbound_text con preámbulo breve + fincas_mostradas con los objetos VERBATIM del listado (hasta ${maxProps}).`,
        },
      );
    }

    if (!finalData) {
      // Loop budget exhausted — force a final response.
      const final = await llm.generate({
        name: 'offering-stage-force-final',
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Ya consultaste suficientes tools. Devuelve un JSON FINAL con done=true. Si tienes fincas para mostrar, intent=SHOW_OPTIONS + outbound_text con preámbulo + fincas_mostradas. NO más tool_calls.',
          },
        ],
        schema: stageDecisionSchema,
        temperature: 0.2,
      });
      await input.trace.recordTurn({
        stage: 'OFFERING',
        model: final.model,
        prompt: { messages, forced: true },
        response: final.data,
        toolsCalled: [],
        tokensIn: final.usage.tokensIn,
        tokensOut: final.usage.tokensOut,
        costUsd: final.usage.costUsd,
        latencyMs: final.latencyMs,
        status: 'ok',
      });
      finalData = final.data;
    }

    const outbound = this.buildOutbound(finalData);

    return {
      intent: finalData.intent,
      extractedData: finalData.extracted_data,
      nextStage: finalData.next_stage,
      outbound,
      toolCalls: toolCallLog.map((c) => ({ ...c })),
      reasoning: finalData.reasoning,
    };
  }

  /**
   * Convert the LLM's decision into the v1-style outbound sequence:
   *   [preamble_text, card_1, media_1, card_2, media_2, ...]
   *
   * If `fincas_mostradas` is populated and intent='SHOW_OPTIONS', we build
   * cards + media via buildPropertySequence. Otherwise just a single text
   * message with outbound_text (or [] if neither).
   */
  private buildOutbound(data: import('@depf/shared').StageDecisionRaw): OutboundMessage[] {
    const out: OutboundMessage[] = [];

    // Always lead with the preamble (LLM's outbound_text). Empty string is
    // skipped — that's how the LLM signals "no extra text, just the cards".
    if (data.outbound_text && data.outbound_text.trim().length > 0) {
      out.push({ channel: 'simulator', type: 'text', text: data.outbound_text.trim() });
    }

    const fincas = (data.fincas_mostradas ?? []) as FincaForCard[];
    if (fincas.length > 0) {
      const sequence = buildPropertySequence(fincas);
      for (const item of sequence) {
        out.push(this.toOutboundMessage(item));
      }
    }

    return out;
  }

  private toOutboundMessage(item: OutboundItem): OutboundMessage {
    if (item.type === 'media_group') {
      const urls = item.media_urls ?? (item.media_url ? [item.media_url] : []);
      return {
        channel: 'simulator',
        type: 'media_group',
        text: item.content || undefined,
        attachments: urls.map((url) => ({
          url,
          mimeType: this.guessMimeType(url),
        })),
      };
    }
    return {
      channel: 'simulator',
      type: 'text',
      text: item.content,
    };
  }

  private guessMimeType(url: string): string {
    const lower = url.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'image/jpeg'; // sensible default for Drive-hosted images
  }
}

export const offeringStage = new OfferingStage();
