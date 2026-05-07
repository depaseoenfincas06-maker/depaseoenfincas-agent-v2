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

/**
 * `zona` and `ciudad` accept EITHER a single string ("Carmen") OR an array
 * (["Carmen", "Girardot"]) when the client mentions multiple options. The
 * preprocess normalizes both shapes to a string array — internally we always
 * work with arrays. Inventory matching is OR across the array.
 */
const zonaListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .pipe(z.array(z.string().min(1)).min(1))
  .optional();

export const searchCriteriaSchema = z
  .object({
    fechaInicio: z.string().optional(),
    fechaFin: z.string().optional(),
    personas: z.number().int().positive().optional(),
    zona: zonaListSchema,
    ciudad: zonaListSchema,
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
 * Tolerant tool_call entry. Gemini frequently emits {tool_name, parameters}
 * instead of {name, input}. We accept either and normalize via preprocess.
 */
const toolCallSchema = z
  .object({
    name: z.string().optional(),
    tool_name: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    parameters: z.record(z.unknown()).optional(),
    arguments: z.record(z.unknown()).optional(),
  })
  .transform((v) => ({
    name: v.name ?? v.tool_name ?? '',
    input: v.input ?? v.parameters ?? v.arguments ?? {},
  }))
  .pipe(z.object({ name: z.string().min(1), input: z.record(z.unknown()) }));

/**
 * The structured JSON we force the LLM to produce on every stage call.
 * Validating this prevents "Max iterations" loops because we never
 * give the LLM permission to keep going beyond what it returns here.
 *
 * Tolerant where it can be: nulls accepted in optional string fields,
 * tool_calls accept both {name,input} and {tool_name,parameters} shapes.
 */
export const stageDecisionSchema = z.preprocess(
  (raw) => {
    if (raw == null || typeof raw !== 'object') return raw;
    const v = raw as Record<string, unknown>;
    // Coerce nulls in optional string fields → undefined so .optional() passes.
    if (v.outbound_text === null) v.outbound_text = undefined;
    if (v.reasoning === null) v.reasoning = '';
    if (v.tool_calls === null) v.tool_calls = [];
    if (v.extracted_data === null) v.extracted_data = {};
    return v;
  },
  z.object({
    intent: intentSchema,
    extracted_data: searchCriteriaSchema.merge(reservationDataSchema).partial(),
    next_stage: stageSchema,
    outbound_text: z.string().optional(),
    tool_calls: z.array(toolCallSchema).default([]),
    reasoning: z.string().default(''),
    done: z.boolean().default(true),
  }),
);

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
