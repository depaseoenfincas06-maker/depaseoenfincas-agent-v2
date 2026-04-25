/**
 * QA stage — floating FAQ agent. Doesn't change conversation state, just
 * answers a question and the next inbound returns to whatever stage the
 * conversation was in.
 *
 * Knowledge sources:
 *   - settings.companyKnowledge (free-form JSON, edited from dashboard)
 *   - settings.paymentMethods
 *   - settings.companyDocuments — agent can request to send a document via
 *     the {tool_calls: [{ name: 'send_document', input: { topic: '...' } }]}
 *     mechanism. We execute it after the LLM responds.
 */
import { z } from 'zod';
import { stageDecisionSchema, type StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { getLLM } from '../llm/index.js';

const QA_SYSTEM = `Eres el agente QA de "De Paseo en Fincas". Respondes preguntas puntuales del cliente sobre la empresa, sus servicios, las propiedades en general, ubicaciones, medios de pago, qué incluye, mascotas, etc.

REGLAS:
- Tono: {TONE_GUIDELINES}
- Sé breve y concreto (1–3 frases). 1 idea por mensaje.
- Si la pregunta es sobre algo que NO está en tu knowledge → di que no tienes esa info y ofrece pasarla a un humano. NO inventes.
- Si el cliente pide un documento específico (RUT, Cámara de Comercio, NIT) → además de responder, agrega un tool_call:
    { "name": "send_document", "input": { "topic": "rut" | "camara_comercio" | "nit" } }
  Tu outbound_text debe DECIR que se lo envías ("Te lo paso ahora mismo"), no decir que lo tienes y dejarlo sin enviar.
- Stage actual: {CURRENT_STAGE} — NO cambies de stage. next_stage = CURRENT_STAGE siempre.
- intent siempre es "QA_ANSWERED" salvo que pidas humano (entonces "HITL_REQUEST", next_stage="HITL").

Información disponible:
- companyKnowledge: {KNOWLEDGE_JSON}
- paymentMethods: {PAYMENT_METHODS_JSON}
- companyDocuments disponibles: {DOCUMENTS_LIST}

DEBES devolver el JSON exacto con la forma de stageDecisionSchema (el orquestador lo validará).`;

const sendDocumentInputSchema = z.object({
  topic: z.string(),
});

class QAStage implements StageHandler {
  // QA is a "virtual stage" — it doesn't appear in the Stage enum because it
  // doesn't change state. We tag it as QUALIFYING for the registry but the
  // orchestrator calls qaStage directly when the router says so.
  readonly stage = 'QUALIFYING' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const llm = getLLM();
    const tone = `${input.settings.tonePreset}. ${input.settings.toneGuidelinesExtra ?? ''}`;
    const documentsList = input.settings.companyDocuments
      .map((d) => `${d.name}${d.topics?.length ? ` (topics: ${d.topics.join(', ')})` : ''}`)
      .join('; ') || '(ninguno configurado)';

    const system = QA_SYSTEM.replace('{TONE_GUIDELINES}', tone)
      .replace('{CURRENT_STAGE}', input.conversation.currentStage)
      .replace('{KNOWLEDGE_JSON}', JSON.stringify(input.settings.companyKnowledge ?? {}, null, 0))
      .replace('{PAYMENT_METHODS_JSON}', JSON.stringify(input.settings.paymentMethods ?? {}, null, 0))
      .replace('{DOCUMENTS_LIST}', documentsList);

    const history = input.recentMessages
      .slice(0, 8)
      .reverse()
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      }));

    const result = await llm.generate({
      name: 'qa-stage',
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: input.userText }],
      schema: stageDecisionSchema,
      temperature: 0.2,
    });

    await input.trace.recordTurn({
      stage: 'classifier', // tag QA turns as classifier in agent_turns to distinguish from main stage
      model: result.model,
      prompt: { system, history, userText: input.userText, kind: 'qa' },
      response: result.data,
      toolsCalled: [],
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      costUsd: result.usage.costUsd,
      latencyMs: result.latencyMs,
      status: 'ok',
    });

    // Resolve send_document tool calls server-side: we attach the document URL
    // to the outbound message instead of letting the LLM make up URLs.
    const data = result.data;
    const outbound = [];
    if (data.outbound_text) {
      outbound.push({ channel: 'simulator' as const, type: 'text' as const, text: data.outbound_text });
    }
    for (const call of data.tool_calls ?? []) {
      if (call.name === 'send_document') {
        const parsed = sendDocumentInputSchema.safeParse(call.input);
        if (!parsed.success) continue;
        const doc = this.findDocument(input.settings.companyDocuments, parsed.data.topic);
        if (doc?.url) {
          outbound.push({
            channel: 'simulator' as const,
            type: 'document' as const,
            attachments: [
              {
                url: doc.url,
                mimeType: 'application/pdf',
                filename: doc.name,
                caption: `${doc.name}`,
              },
            ],
          });
        }
      }
    }

    // QA never transitions stage by itself (unless escalating to HITL).
    const nextStage =
      data.intent === 'HITL_REQUEST' ? 'HITL' : input.conversation.currentStage;

    return {
      intent: data.intent,
      extractedData: data.extracted_data,
      nextStage,
      outbound,
      toolCalls: (data.tool_calls ?? []).map((c) => ({ name: c.name, input: c.input })),
      reasoning: data.reasoning,
    };
  }

  private findDocument(
    documents: Array<{ name: string; url?: string; topics?: string[] }>,
    topic: string,
  ): { name: string; url?: string } | null {
    const t = topic.toLowerCase().trim();
    return (
      documents.find(
        (d) => d.name.toLowerCase().includes(t) || d.topics?.some((tag) => tag.toLowerCase() === t),
      ) ?? null
    );
  }
}

export const qaStage = new QAStage();
