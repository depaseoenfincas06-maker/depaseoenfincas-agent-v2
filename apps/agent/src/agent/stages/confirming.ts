/**
 * CONFIRMING_RESERVATION stage. Collects titular data (name, doc, phone,
 * email, address) until complete; then triggers PDF generation and HITL.
 *
 * Privacy: in this stage the agent CAN reveal the finca's real name (it's
 * about to be on the reservation document anyway).
 */
import { stageDecisionSchema, type StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { getLLM } from '../llm/index.js';
import { getFincaById } from '../../inventory/loader.js';
import { generateReservationPDF } from '../tools/generate-pdf.js';
import { logger } from '../../observability/logger.js';

const CONFIRMING_SYSTEM = `Eres el asistente de "De Paseo en Fincas" en el estado CONFIRMING_RESERVATION.

OBJETIVO: tomar los datos del titular para emitir la confirmación. Datos requeridos:
  - nombreCompleto
  - tipoDocumento (CC | CE | PASAPORTE)
  - numeroDocumento
  - celular
  - email
  - direccion

REGLAS:
- Tono: {TONE_GUIDELINES}
- En este estado SÍ puedes mencionar el nombre real de la finca: "{FINCA_NAME}".
- Pide TODOS los datos faltantes en un solo mensaje, no de a uno. Ejemplo:
  "Para emitir tu confirmación necesito tu nombre completo, tipo y número de documento, celular, email y dirección."
- Si el cliente entrega varios datos en un mensaje, extráelos todos en extracted_data.
- Si el cliente pregunta algo (precios, medios de pago) → intent=QUESTION, responde, sigue en este stage.
- Si quiere cambiar de finca → intent=CHANGE_FINCA, next_stage=OFFERING.
- Cuando TODOS los datos estén completos → intent=DOCUMENT_READY, next_stage=HITL, outbound_text="te envío la confirmación ahora mismo".

Datos ya capturados: {RESERVATION_SO_FAR}
Medios de pago: {PAYMENT_METHODS}

DEBES devolver el JSON exacto con la forma de stageDecisionSchema.`;

const REQUIRED_FIELDS = [
  'nombreCompleto',
  'tipoDocumento',
  'numeroDocumento',
  'celular',
  'email',
  'direccion',
] as const;

function isComplete(reservation: Record<string, unknown> | undefined): boolean {
  if (!reservation) return false;
  return REQUIRED_FIELDS.every((f) => {
    const v = reservation[f];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

class ConfirmingStage implements StageHandler {
  readonly stage = 'CONFIRMING_RESERVATION' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const llm = getLLM();
    const tone = `${input.settings.tonePreset}. ${input.settings.toneGuidelinesExtra ?? ''}`;
    const fincaId = input.conversation.selectedFinca;
    const finca = fincaId ? await getFincaById(fincaId) : null;
    const fincaName = finca?.realName ?? '(finca por confirmar)';
    const reservationSoFar = input.conversation.reservation ?? {};

    const system = CONFIRMING_SYSTEM.replace('{TONE_GUIDELINES}', tone)
      .replace('{FINCA_NAME}', fincaName)
      .replace('{RESERVATION_SO_FAR}', JSON.stringify(reservationSoFar))
      .replace('{PAYMENT_METHODS}', JSON.stringify(input.settings.paymentMethods ?? {}));

    const history = input.recentMessages
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      }));

    const result = await llm.generate({
      name: 'confirming-stage',
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: input.userText }],
      schema: stageDecisionSchema,
      temperature: 0.2,
    });

    await input.trace.recordTurn({
      stage: 'CONFIRMING_RESERVATION',
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
    // Merge extracted_data into reservationSoFar for completeness check
    const merged = { ...reservationSoFar, ...data.extracted_data };
    const complete = isComplete(merged);

    const outbound: StageDecision['outbound'] = [];
    if (data.outbound_text) {
      outbound.push({ channel: 'simulator', type: 'text', text: data.outbound_text });
    }

    if (complete && data.intent === 'DOCUMENT_READY' && finca) {
      try {
        const pdf = await generateReservationPDF({
          finca,
          reservation: merged as Record<string, string>,
          searchCriteria: input.conversation.searchCriteria ?? {},
          paymentMethods: input.settings.paymentMethods ?? {},
        });
        outbound.push({
          channel: 'simulator',
          type: 'document',
          attachments: [
            {
              data: pdf.base64,
              mimeType: 'application/pdf',
              filename: pdf.filename,
              caption: 'Confirmación de tu reserva',
            },
          ],
        });
      } catch (err) {
        logger.error({ err }, 'pdf generation failed');
        outbound.push({
          channel: 'simulator',
          type: 'text',
          text: 'Tuve un inconveniente generando el PDF de confirmación. Un asesor te lo enviará en breve.',
        });
      }
    }

    return {
      intent: data.intent,
      extractedData: data.extracted_data,
      nextStage: complete && data.intent === 'DOCUMENT_READY' ? 'HITL' : data.next_stage,
      outbound,
      toolCalls: [],
      reasoning: data.reasoning,
    };
  }
}

export const confirmingStage = new ConfirmingStage();
