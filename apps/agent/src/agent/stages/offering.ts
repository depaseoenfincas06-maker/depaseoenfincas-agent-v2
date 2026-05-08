/**
 * OFFERING stage handler. Critical privacy invariant: NEVER reveal a finca's
 * real name in this stage — only fincaId.
 *
 * This is the stage that hit "Max iterations 4" in the n8n workflow because
 * the agent kept calling tools. We cap iterations at 3 IN CODE: the LLM can
 * either return a final response in iteration 1 (preferred), or call tools
 * up to 3 times before we force a final response. After iteration 3, if the
 * LLM still wants tools, we ignore them and ask for a final answer.
 */
import { stageDecisionSchema, type StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { buildToneBlock, withStageAddendum } from './types.js';
import { getLLM } from '../llm/index.js';
import { executeInventoryTool, INVENTORY_TOOL_DESCRIPTIONS } from '../tools/inventory-reader.js';

const MAX_TOOL_ITERATIONS = 3;

const OFFERING_SYSTEM = `Eres el asistente conversacional de "De Paseo en Fincas". Estás en el estado OFFERING.

OBJETIVO: presentar al cliente hasta {MAX_PROPERTIES} fincas que coincidan con sus criterios. Capturar cuál elige.

REGLAS CRÍTICAS:
- Tono: {TONE_GUIDELINES}
- NUNCA reveles el nombre real de una finca. Usa el fincaId (código) o frases genéricas como "una finca con piscina en Carmen". El nombre real solo se revela en CONFIRMING_RESERVATION.
- Cuando muestres opciones, usa fincaIds. Ejemplo: "Tengo 3 opciones: F001 con jacuzzi, F003 cerca al río, F008 con BBQ. ¿Cuál te llama la atención?"
- Si el cliente dice "la 2", "el F003", "la del río", mapea a la finca correcta y pon su fincaId en extracted_data.finca_elegida_id.
- Si tienes los criterios de búsqueda y NO has llamado list_matching_fincas, llámala ANTES de responder.
- excludeIds debe incluir las fincas YA mostradas (te las paso como contexto).
- Si el cliente pide "más opciones", llama list_matching_fincas con excludeIds = todas las mostradas.
- Si no hay matches, di que no encontraste y propón ajustar criterios (próximo intent: ADJUST_CRITERIA o NO_MATCH).

INTENTS:
- SHOW_OPTIONS — vas a mostrar fincas. next_stage=OFFERING.
- CLIENT_CHOSE — el cliente eligió una finca. next_stage=VERIFYING_AVAILABILITY. extracted_data debe traer finca_elegida_id (= fincaId).
- ADJUST_CRITERIA — el cliente cambió criterios. next_stage=OFFERING.
- NO_MATCH — no hay fincas. next_stage=OFFERING.
- QUESTION — pregunta puntual. next_stage=OFFERING.
- HITL_REQUEST / CANCEL — next_stage=HITL.

CONTEXTO:
- search_criteria: {SEARCH_CRITERIA}
- shown_fincas (NO repetir): {SHOWN_FINCAS}

NOTA sobre zona/ciudad:
- search_criteria.zona puede ser un ARRAY (ej. ["Carmen","Girardot"]). Cuando llames list_matching_fincas, pasa el mismo array como zona — el tool busca con OR (cualquiera de las zonas matchea).
- Si en algún mensaje el cliente menciona destinos adicionales ("¿qué tienes también en Melgar?"), agrégalo al array en extracted_data.zona y vuelve a llamar list_matching_fincas con el array actualizado + excludeIds = shown_fincas.

${INVENTORY_TOOL_DESCRIPTIONS}

DEBES devolver UN JSON con la forma de stageDecisionSchema. Si necesitas tools, ponlos en tool_calls con done=false. Si tu respuesta es final, done=true y outbound_text con tu mensaje al cliente.`;

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
        .replace('{MAX_PROPERTIES}', String(maxProps)),
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
        // Final response.
        return {
          intent: data.intent,
          extractedData: data.extracted_data,
          nextStage: data.next_stage,
          outbound: data.outbound_text
            ? [{ channel: 'simulator', type: 'text', text: data.outbound_text }]
            : [],
          toolCalls: toolCallLog.map((c) => ({ ...c })),
          reasoning: data.reasoning,
        };
      }

      // Execute tools and feed results back.
      const toolResults: Array<{ name: string; input: unknown; output: unknown }> = [];
      for (const call of data.tool_calls ?? []) {
        const result = await executeInventoryTool(call.name, call.input);
        toolResults.push({ name: call.name, input: call.input, output: result });
        toolCallLog.push({ name: call.name, input: call.input, output: result });
      }
      messages.push(
        { role: 'assistant', content: JSON.stringify({ tool_calls: data.tool_calls, done: false }) },
        {
          role: 'user',
          content: `[Resultados de tools]\n${JSON.stringify(toolResults, null, 0)}\n\nAhora produce tu JSON final con done=true y outbound_text.`,
        },
      );
    }

    // Loop budget exhausted — force a final response.
    const final = await llm.generate({
      name: 'offering-stage-force-final',
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            'Ya consultaste suficientes tools. Devuelve un JSON FINAL con done=true y outbound_text al cliente — no más tool_calls.',
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

    const data = final.data;
    return {
      intent: data.intent,
      extractedData: data.extracted_data,
      nextStage: data.next_stage,
      outbound: data.outbound_text
        ? [{ channel: 'simulator', type: 'text', text: data.outbound_text }]
        : [],
      toolCalls: toolCallLog.map((c) => ({ ...c })),
      reasoning: data.reasoning,
    };
  }
}

export const offeringStage = new OfferingStage();
