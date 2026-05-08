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
import { getFincaById } from '../../inventory/loader.js';
import type { Finca } from '../../inventory/types.js';

const MAX_TOOL_ITERATIONS = 3;

const OFFERING_SYSTEM = `Eres el asistente conversacional de "De Paseo en Fincas". Estás en el estado OFFERING.

OBJETIVO: presentar al cliente hasta {MAX_PROPERTIES} fincas que coincidan con sus criterios. Capturar cuál elige.

REGLAS CRÍTICAS DE PRIVACIDAD:
- NUNCA reveles el nombre real de una finca (campo "nombre" o "realName"). Usa SIEMPRE el codigo_original (ej. "PEREIRA #09", "CARMEN #03") o frases genéricas como "una finca con piscina en Carmen". El nombre real solo se revela en CONFIRMING_RESERVATION.
- En tu outbound_text al cliente NO menciones nunca "nombre" ni hagas referencia a uno. Refiérete por código.

TONO: {TONE_GUIDELINES}

CÓMO PRESENTAR FINCAS — REGLA INVIOLABLE:
- Cuando muestres fincas devuelves SIEMPRE:
    intent: "SHOW_OPTIONS"
    next_stage: "OFFERING"
    outbound_text: un PREÁMBULO breve (≤ 35 palabras) en español, conversacional. Ejemplos:
        - Caso normal: "¡Genial! Encontré estas opciones para ti, mira a ver cuál te late más:"
        - Caso similar_items (no hay match estricto): "En esa zona no tengo opciones disponibles, pero te muestro estas alternativas cercanas que pueden funcionarte:"
    fincas_mostradas: ARRAY con SOLO los finca_id (strings) de las fincas que decidiste mostrar, en el orden que quieres mostrarlas. Ejemplo: ["F009","F003","F005"]. Hasta {MAX_PROPERTIES} ids. NO objetos completos, NO descripciones, SOLO ids.
    done: true

- El sistema construye AUTOMÁTICAMENTE las fichas con su formato (☀️🌴*PEREIRA #09*🌴☀️ + amenidades + tarifa) buscando cada finca_id en el inventario y luego envía las fotos. Tu única responsabilidad es decidir CUÁLES IDs mostrar y en qué orden.

- PROHIBIDO: escribir las fichas como texto en outbound_text. Si lo haces, el cliente no verá las fotos y la ficha tendrá descripciones inventadas. SIEMPRE pasa los IDs en fincas_mostradas.

- Si list_matching_fincas devolvió matches=[] y similar_items=[…X items], pon los IDs de similar_items en fincas_mostradas y avisa en el preámbulo.

- Si AMBOS están vacíos: intent="NO_MATCH", outbound_text="No encontré opciones que cumplan esos criterios. ¿Quieres ajustar algo (fechas, presupuesto, zona)?", fincas_mostradas=[].

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
        maxTokens: 4096,
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
        const out = await executeInventoryTool(call.name, call.input, {
          searchCriteria: input.conversation.searchCriteria as Record<string, unknown> | undefined,
          ...(input.settings.ownerContactOverride
            ? { ownerContactOverride: input.settings.ownerContactOverride }
            : {}),
        });
        toolResults.push({ name: call.name, input: call.input, output: out });
        toolCallLog.push({ name: call.name, input: call.input, output: out });
      }
      messages.push(
        { role: 'assistant', content: JSON.stringify({ tool_calls: data.tool_calls, done: false }) },
        {
          role: 'user',
          content: `[Resultados de tools]\n${JSON.stringify(toolResults, null, 0)}\n\nAhora produce tu JSON FINAL con done=true. Si vas a mostrar fincas: intent=SHOW_OPTIONS + outbound_text con preámbulo breve + fincas_mostradas como array de finca_id (strings, hasta ${maxProps}). El sistema construye las fichas; tú solo eliges qué IDs mostrar.`,
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
              'Ya consultaste suficientes tools. Devuelve un JSON FINAL con done=true. Si tienes fincas para mostrar, intent=SHOW_OPTIONS + outbound_text con preámbulo + fincas_mostradas como array de finca_id strings. NO más tool_calls.',
          },
        ],
        schema: stageDecisionSchema,
        temperature: 0.2,
        maxTokens: 4096,
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

    const outbound = await this.buildOutbound(finalData);

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
   * The LLM passes `fincas_mostradas` as either an array of finca_id strings
   * (preferred — keeps the JSON small enough to never truncate) or as full
   * objects (legacy / fallback). Either way we resolve each entry to the
   * canonical Finca from the inventory and build the card via
   * `buildPropertySequence` so the formatting (codigo_original, emojis,
   * tarifa, photos) is always our code, never the LLM's paraphrase.
   */
  private async buildOutbound(
    data: import('@depf/shared').StageDecisionRaw,
  ): Promise<OutboundMessage[]> {
    const out: OutboundMessage[] = [];

    if (data.outbound_text && data.outbound_text.trim().length > 0) {
      out.push({ channel: 'simulator', type: 'text', text: data.outbound_text.trim() });
    }

    const raw = data.fincas_mostradas ?? [];
    const cards: FincaForCard[] = [];
    for (const entry of raw as unknown[]) {
      // Case A: bare string ID
      if (typeof entry === 'string' && entry.trim().length > 0) {
        const finca = await getFincaById(entry.trim());
        if (finca) cards.push(this.fincaToCard(finca));
        continue;
      }
      // Case B: object — could be a full FincaForCard already, or an
      // {finca_id} stub. Try to look up canonical first; fall back to the
      // object as-is.
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        const id = String(obj.finca_id ?? obj.fincaId ?? '');
        if (id) {
          const finca = await getFincaById(id);
          if (finca) {
            cards.push(this.fincaToCard(finca));
            continue;
          }
        }
        // No id match — best-effort with whatever the LLM provided.
        cards.push(obj as FincaForCard);
      }
    }

    if (cards.length > 0) {
      const sequence = buildPropertySequence(cards);
      for (const item of sequence) {
        out.push(this.toOutboundMessage(item));
      }
    }

    return out;
  }

  /** Map a canonical Finca (from the inventory) to the FincaForCard shape
   *  buildFincaCard expects. */
  private fincaToCard(f: Finca): FincaForCard {
    return {
      finca_id: f.fincaId,
      fincaId: f.fincaId,
      ...(f.realName ? { realName: f.realName } : {}),
      ...(f.codigo_original ? { codigo_original: f.codigo_original } : {}),
      zona: f.zona,
      ...(f.ciudad ? { ciudad: f.ciudad, municipio: f.ciudad } : {}),
      ...(f.habitaciones != null ? { habitaciones: f.habitaciones } : {}),
      ...(f.capacidadMax != null
        ? { capacidad_max: f.capacidadMax, capacidadMax: f.capacidadMax }
        : {}),
      amenidades: f.amenidades ?? [],
      ...(f.descripcionCorta
        ? { descripcion_corta: f.descripcionCorta, descripcionCorta: f.descripcionCorta }
        : {}),
      ...(f.observaciones_originales
        ? { observaciones_originales: f.observaciones_originales }
        : {}),
      ...(f.caracteristicas_originales
        ? { caracteristicas_originales: f.caracteristicas_originales }
        : {}),
      ...(f.especificacion_habitaciones
        ? { especificacion_habitaciones: f.especificacion_habitaciones }
        : {}),
      ...(f.precio_noche_base != null ? { precio_noche_base: f.precio_noche_base } : {}),
      ...(f.precio_fin_semana != null ? { precio_fin_semana: f.precio_fin_semana } : {}),
      ...(f.precioPorNoche != null ? { precioPorNoche: f.precioPorNoche } : {}),
      ...(f.foto_url ? { foto_url: f.foto_url } : {}),
      fotos: f.fotos ?? [],
    };
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
