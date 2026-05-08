import type { Channel, OutboundMessage } from '@depf/shared';

export interface SendResult {
  externalMessageId?: string;
  delivered: boolean;
  raw?: unknown;
  /** Reason if delivered=false, surfaced to traces/logs. */
  failureReason?: string;
}

export interface TypingPayload {
  /** External message id we are about to respond to (wamid for whatsapp). */
  inResponseTo?: string;
}

/**
 * Context for a send operation. Channels need different ids depending on
 * the upstream system: Chatwoot wants its internal numeric conversation_id,
 * WhatsApp wants the recipient phone (wa_id), simulator just echoes.
 */
export interface SendContext {
  /** Our canonical id (the wa_id / phone for WhatsApp-rooted convs). */
  waId: string;
  /** Chatwoot's internal numeric conversation id, if known. Required for
   *  chatwoot adapter to deliver back to the user. */
  chatwootConversationId?: number;
  /** Whether we're already replying inside an existing conversation. */
  contactName?: string;
}

/**
 * One adapter per channel. Adapters are responsible for the wire format
 * of a given channel; they don't know anything about the agent state machine.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** Send a message. Implementations should be idempotent if possible. */
  send(ctx: SendContext, message: OutboundMessage): Promise<SendResult>;
  /**
   * Show typing indicator. Optional — no-op channels just resolve.
   * Adapters that have native auto-dismiss (WhatsApp) should not require turnoff.
   */
  showTyping?(ctx: SendContext, payload: TypingPayload): Promise<void>;
}
