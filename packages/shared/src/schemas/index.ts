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
 * Map of common Gemini intent variants → canonical intents in our enum.
 * Whenever the LLM emits an intent that's "close enough", we coerce it
 * instead of failing validation. This is essential for stages where the
 * LLM doesn't have one obvious intent name (CONFIRMING data collection,
 * QA send_document responses, etc.). Add liberally — defense in depth.
 */
const INTENT_ALIASES: Record<string, string> = {
  CONTINUE: 'QUESTION',
  CONTINUING: 'QUESTION',
  COLLECTING: 'REQUEST_CONFIRMATION_DATA',
  COLLECT_DATA: 'REQUEST_CONFIRMATION_DATA',
  PROVIDE_INFO: 'REQUEST_CONFIRMATION_DATA',
  EXTRACT_DATA: 'REQUEST_CONFIRMATION_DATA',
  GATHERING_DATA: 'REQUEST_CONFIRMATION_DATA',
  PROVIDE_DOCUMENT: 'QA_ANSWERED',
  SEND_DOCUMENT: 'QA_ANSWERED',
  INFORM: 'QA_ANSWERED',
  ANSWERING: 'QA_ANSWERED',
  ASK_HUMAN: 'HITL_REQUEST',
  ESCALATE: 'HITL_REQUEST',
  HANDOFF: 'HITL_REQUEST',
  PRESENT_OPTIONS: 'SHOW_OPTIONS',
  PRESENT_FINCAS: 'SHOW_OPTIONS',
  CHOSE: 'CLIENT_CHOSE',
  CLIENT_SELECTED: 'CLIENT_CHOSE',
  ADJUST: 'ADJUST_CRITERIA',
  REFINE_SEARCH: 'ADJUST_CRITERIA',
  GREET: 'GREETING',
  GENERATE_PDF: 'DOCUMENT_READY',
  PDF_READY: 'DOCUMENT_READY',
};

/**
 * The structured JSON we force the LLM to produce on every stage call.
 * Validating this prevents "Max iterations" loops because we never
 * give the LLM permission to keep going beyond what it returns here.
 *
 * Tolerant where it can be:
 *  - nulls accepted in optional string fields → undefined
 *  - tool_calls null/missing → []
 *  - tool_call (singular) → tool_calls (array of 1)
 *  - {name, input} or {tool_name, parameters} on each tool call
 *  - extracted_data null/missing → {}
 *  - intent variants mapped to canonical via INTENT_ALIASES
 *  - next_stage null/missing → undefined (stage handler defaults to current)
 */
export const stageDecisionSchema = z.preprocess(
  (raw) => {
    if (raw == null || typeof raw !== 'object') return raw;
    const v = raw as Record<string, unknown>;

    // String fields with null tolerance
    if (v.outbound_text === null) v.outbound_text = undefined;
    if (v.reasoning === null) v.reasoning = '';

    // tool_calls: null/missing → []
    if (v.tool_calls == null) v.tool_calls = [];

    // tool_call (singular) — Gemini sometimes emits this when there's exactly 1
    if (v.tool_call != null) {
      const single = v.tool_call;
      if (Array.isArray(v.tool_calls) && v.tool_calls.length === 0) {
        v.tool_calls = Array.isArray(single) ? single : [single];
      }
      delete v.tool_call;
    }

    // extracted_data: null/missing → {}
    if (v.extracted_data == null) v.extracted_data = {};

    // intent aliases — case-insensitive lookup
    if (typeof v.intent === 'string') {
      const upper = v.intent.toUpperCase().trim();
      if (INTENT_ALIASES[upper]) {
        v.intent = INTENT_ALIASES[upper];
      } else {
        // Normalize casing for direct enum match
        v.intent = upper;
      }
    }

    // next_stage: null → undefined → schema default
    if (v.next_stage == null) v.next_stage = undefined;

    return v;
  },
  z.object({
    intent: intentSchema,
    extracted_data: searchCriteriaSchema.merge(reservationDataSchema).partial(),
    // next_stage stays required at the type level, but if undefined the LLM
    // didn't decide — caller should fall back to current stage.
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
