/**
 * Shared types between agent backend and dashboard frontend.
 * Keep this small and stable — these cross the wire.
 */

export type Stage =
  | 'QUALIFYING'
  | 'OFFERING'
  | 'VERIFYING_AVAILABILITY'
  | 'CONFIRMING_RESERVATION'
  | 'HITL';

export type Intent =
  | 'GREETING'
  | 'QUALIFYING'
  | 'SHOW_OPTIONS'
  | 'CLIENT_CHOSE'
  | 'ADJUST_CRITERIA'
  | 'NO_MATCH'
  | 'WAITING_OWNER'
  | 'CHANGE_FINCA'
  | 'REQUEST_CONFIRMATION_DATA'
  | 'DOCUMENT_READY'
  | 'QUESTION'
  | 'QA_ANSWERED'
  | 'OFF_TOPIC'
  | 'HITL_REQUEST'
  | 'CANCEL';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageType =
  | 'TEXT'
  | 'AUDIO'
  | 'AUDIO_UNTRANSCRIBED'
  | 'IMAGE'
  | 'VIDEO'
  | 'DOCUMENT'
  | 'LOCATION'
  | 'CONTACT'
  | 'STICKER'
  | 'INTERACTIVE'
  | 'SYSTEM';

export type TranscriptionStatus = 'ok' | 'empty' | 'failed' | null;

export type TraceStatus = 'ok' | 'silent' | 'fallback' | 'error';

export type AgentTurnStatus = 'ok' | 'malformed' | 'timeout' | 'error';

export type SilenceReason =
  | 'HITL_ACTIVE'
  | 'GLOBAL_BOT_DISABLED'
  | 'OUT_OF_OPERATING_HOURS'
  | 'DUPLICATE_MESSAGE'
  | 'EXPLICITLY_IGNORED';

export type FallbackReason =
  | 'NO_OUTBOUND_NO_REASON'
  | 'LLM_MALFORMED_AFTER_RETRIES'
  | 'TOOL_LOOP_EXHAUSTED'
  | 'STAGE_HANDLER_THREW'
  | 'CHANNEL_SEND_FAILED'
  | 'TRANSCRIPTION_EMPTY';

export type Channel = 'chatwoot' | 'whatsapp' | 'simulator';

export interface ConversationContext {
  waId: string;
  chatwootConversationId?: number;
  clientName?: string;
  currentStage: Stage;
  searchCriteria: SearchCriteria;
  shownFincas: string[];
  selectedFinca?: string;
  ownerResponse?: OwnerResponse;
  pricing?: Pricing;
  reservation?: ReservationData;
  agenteActivo: boolean;
  hitlReason?: string;
  extras: Record<string, unknown>;
}

export interface SearchCriteria {
  fechaInicio?: string;
  fechaFin?: string;
  personas?: number;
  /**
   * Internally always stored as string[] after schema preprocess. Inventory
   * matching is OR across the array (any zone match passes).
   */
  zona?: string[];
  ciudad?: string[];
  presupuestoMax?: number;
  tipoEvento?: string;
  amenidades?: string[];
  mascotas?: boolean;
}

export interface OwnerResponse {
  disponible?: boolean;
  respondedAt?: string;
  message?: string;
}

export interface Pricing {
  baseRate?: number;
  totalNights?: number;
  total?: number;
  currency?: string;
}

export interface ReservationData {
  nombreCompleto?: string;
  tipoDocumento?: 'CC' | 'CE' | 'PASAPORTE';
  numeroDocumento?: string;
  celular?: string;
  email?: string;
  direccion?: string;
}

export interface OutboundMessage {
  channel: Channel;
  type: 'text' | 'image' | 'document' | 'media_group';
  text?: string;
  attachments?: OutboundAttachment[];
}

export interface OutboundAttachment {
  url?: string;
  data?: string; // base64 if uploading
  mimeType: string;
  filename?: string;
  caption?: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
}

export interface StageDecision {
  intent: Intent;
  extractedData: Partial<SearchCriteria & ReservationData>;
  nextStage: Stage;
  outbound: OutboundMessage[];
  toolCalls: ToolCall[];
  reasoning: string;
}

export interface Trace {
  id: string;
  conversationId: string;
  inboundMessageId: string | null;
  stageBefore: Stage | null;
  stageAfter: Stage | null;
  intent: Intent | null;
  outboundCount: number;
  status: TraceStatus;
  durationMs: number | null;
  errorDetail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentTurn {
  id: string;
  traceId: string;
  stage: Stage | 'router' | 'classifier';
  model: string;
  prompt: unknown;
  response: unknown;
  toolsCalled: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: AgentTurnStatus;
  createdAt: string;
}

export interface FallbackEvent {
  id: string;
  conversationId: string;
  traceId: string | null;
  reason: FallbackReason;
  context: Record<string, unknown>;
  createdAt: string;
}
