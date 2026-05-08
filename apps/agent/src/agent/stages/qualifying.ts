/**
 * QUALIFYING stage handler. Goal: collect minimum data (dates, people count,
 * zone) before moving to OFFERING.
 *
 * Output is the structured StageDecision JSON. We rely on the LLM provider's
 * schema validation; if the LLM returns garbage, the provider retries once and
 * then throws — the orchestrator catches and triggers fallback.
 */
import { stageDecisionSchema } from '@depf/shared';
import type { StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { buildToneBlock, withStageAddendum } from './types.js';
import { getLLM } from '../llm/index.js';
import { buildGreetingContext } from '../greeting-context.js';

const QUALIFYING_SYSTEM = `Eres el asistente conversacional de "De Paseo en Fincas", una empresa colombiana que renta fincas vacacionales. Estás en el estado QUALIFYING.

OBJETIVO de este estado: recopilar los datos mínimos del cliente — fecha de inicio, fecha de fin, número de personas, y zona/destino. Si el cliente da algunos datos pero faltan otros, pídelos de forma natural y breve.

REGLAS:
- Tono: {TONE_GUIDELINES}
- Sé breve (1–3 frases). Una pregunta máximo por mensaje.
- NO inventes información que no tengas.
- Si el cliente saluda solamente → intent="GREETING", responde con saludo y la primera pregunta.
- Si el cliente da datos parciales o completos → intent="QUALIFYING".
- Si los DATOS MÍNIMOS están completos (personas + zona/destino + alguna referencia temporal aunque sea coloquial como "este finde", "el sábado", "del 15 al 17") → DEBES poner next_stage="OFFERING". Convierte fechas coloquiales a YYYY-MM-DD usando el contexto (hoy, próximo fin de semana, etc.). El sistema corre OFFERING inmediatamente en el mismo turno.
- Cuando avances a OFFERING, tu outbound_text DEBE ser muy breve (≤ 15 palabras) — solo un acuse de recibo tipo "¡Súper! Te muestro opciones disponibles." NO digas "te busco" ni "dame un momentico" — el sistema mostrará las fincas en el MISMO mensaje, no después.
- Si el cliente pide hablar con humano → intent="HITL_REQUEST", next_stage="HITL".
- Si el cliente quiere cancelar → intent="CANCEL", next_stage="HITL".
- Si dice algo fuera de tema → intent="OFF_TOPIC", redirige amablemente.

DEBES devolver un JSON con esta forma exacta:
{
  "intent": "GREETING|QUALIFYING|QUESTION|HITL_REQUEST|OFF_TOPIC|CANCEL",
  "extracted_data": { "fechaInicio"?: "YYYY-MM-DD", "fechaFin"?: "YYYY-MM-DD", "personas"?: number, "zona"?: string },
  "next_stage": "QUALIFYING|OFFERING|HITL",
  "outbound_text": "<lo que respondes al cliente, en español colombiano>",
  "tool_calls": [],
  "reasoning": "<por qué decidiste así, 1 frase>",
  "done": true
}`;

class QualifyingStage implements StageHandler {
  readonly stage = 'QUALIFYING' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const llm = getLLM();
    const tone = buildToneBlock(input.settings);

    // Greeting context: enriches the very first turn with a personalised
    // saludo. v1 parity — when a brand new conversation lands in QUALIFYING
    // we want "¡Buenas tardes, María!" not a generic opener.
    const greeting = buildGreetingContext({
      currentStage: input.conversation.currentStage,
      recentMessageCount: input.recentMessages.length,
      clientName: input.conversation.clientName,
    });

    const greetingBlock = greeting.isInitialQualifyingTurn
      ? `\nCONTEXTO DEL SALUDO:\n- es_inicio: true (este es el primer mensaje de la conversación)\n- saludo_horario: "${greeting.greetingPhrase}" (Bogotá, ${greeting.timeBucket})\n- nombre_cliente: ${greeting.nameCandidate ? `"${greeting.nameCandidate}"` : 'desconocido — NO inventes uno'}\nUsa estos datos para construir un saludo natural ANTES de la primera pregunta.`
      : '';

    const system = withStageAddendum(
      QUALIFYING_SYSTEM.replace('{TONE_GUIDELINES}', tone) + greetingBlock,
      input.settings.promptAddenda?.qualifying,
    );

    const history = input.recentMessages
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      }));

    const result = await llm.generate({
      name: 'qualifying-stage',
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: input.userText },
      ],
      schema: stageDecisionSchema,
      temperature: 0.3,
    });

    await input.trace.recordTurn({
      stage: 'QUALIFYING',
      model: result.model,
      prompt: { system, history, userText: input.userText },
      response: result.data,
      toolsCalled: [],
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      costUsd: result.usage.costUsd,
      latencyMs: result.latencyMs,
      status: 'ok',
    });

    const data = result.data;
    return {
      intent: data.intent,
      extractedData: data.extracted_data,
      nextStage: data.next_stage,
      outbound: data.outbound_text
        ? [{ channel: 'simulator', type: 'text', text: data.outbound_text }]
        : [],
      toolCalls: [],
      reasoning: data.reasoning,
    };
  }
}

export const qualifyingStage = new QualifyingStage();
