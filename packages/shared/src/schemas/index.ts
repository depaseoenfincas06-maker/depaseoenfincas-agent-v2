import { z } from 'zod';

export const stageSchema = z.enum([
  'QUALIFYING',
  'OFFERING',
  'VERIFYING_AVAILABILITY',
  'CONFIRMING_RESERVATION',
  'HITL',
]);

export const intentSchema = z.enum([
  'GREETING',
  'QUALIFYING',
  'SHOW_OPTIONS',
  'CLIENT_CHOSE',
  'ADJUST_CRITERIA',
  'NO_MATCH',
  'WAITING_OWNER',
  'CHANGE_FINCA',
  'REQUEST_CONFIRMATION_DATA',
  'DOCUMENT_READY',
  'QUESTION',
  'QA_ANSWERED',
  'OFF_TOPIC',
  'HITL_REQUEST',
  'CANCEL',
]);

export const channelSchema = z.enum(['chatwoot', 'whatsapp', 'simulator']);

export const messageTypeSchema = z.enum([
  'TEXT',
  'AUDIO',
  'AUDIO_UNTRANSCRIBED',
  'IMAGE',
  'VIDEO',
  'DOCUMENT',
  'LOCATION',
  'CONTACT',
  'STICKER',
  'INTERACTIVE',
  'SYSTEM',
]);

export const searchCriteriaSchema = z
  .object({
    fechaInicio: z.string().optional(),
    fechaFin: z.string().optional(),
    personas: z.number().int().positive().optional(),
    zona: z.string().optional(),
    presupuestoMax: z.number().nonnegative().optional(),
    tipoEvento: z.string().optional(),
    amenidades: z.array(z.string()).optional(),
    mascotas: z.boolean().optional(),
  })
  .strict();

export const reservationDataSchema = z
  .object({
    nombreCompleto: z.string().optional(),
    tipoDocumento: z.enum(['CC', 'CE', 'PASAPORTE']).optional(),
    numeroDocumento: z.string().optional(),
    celular: z.string().optional(),
    email: z.string().email().optional(),
    direccion: z.string().optional(),
  })
  .strict();

/**
 * The structured JSON we force the LLM to produce on every stage call.
 * Validating this prevents "Max iterations" loops because we never
 * give the LLM permission to keep going beyond what it returns here.
 */
export const stageDecisionSchema = z.object({
  intent: intentSchema,
  extracted_data: searchCriteriaSchema.merge(reservationDataSchema).partial(),
  next_stage: stageSchema,
  outbound_text: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        name: z.string(),
        input: z.record(z.unknown()),
      }),
    )
    .default([]),
  reasoning: z.string(),
  done: z.boolean().default(true),
});

export type StageDecisionRaw = z.infer<typeof stageDecisionSchema>;

export const inboundWebhookSchema = z.object({
  channel: channelSchema,
  conversationId: z.string(),
  externalMessageId: z.string().optional(),
  waId: z.string().optional(),
  clientName: z.string().optional(),
  text: z.string().optional(),
  media: z
    .object({
      url: z.string(),
      mimeType: z.string(),
      filename: z.string().optional(),
      durationSec: z.number().optional(),
    })
    .optional(),
  receivedAt: z.string().optional(),
});

export type InboundWebhook = z.infer<typeof inboundWebhookSchema>;
