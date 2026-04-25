import type { Channel, OutboundMessage } from '@depf/shared';

export interface SendResult {
  externalMessageId?: string;
  delivered: boolean;
  raw?: unknown;
}

export interface TypingPayload {
  /** External message id we are about to respond to (wamid for whatsapp). */
  inResponseTo?: string;
}

/**
 * One adapter per channel. Adapters are responsible for the wire format
 * of a given channel; they don't know anything about the agent state machine.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** Send a message. Implementations should be idempotent if possible. */
  send(conversationId: string, message: OutboundMessage): Promise<SendResult>;
  /**
   * Show typing indicator. Optional — no-op channels just resolve.
   * Adapters that have native auto-dismiss (WhatsApp) should not require turnoff.
   */
  showTyping?(conversationId: string, payload: TypingPayload): Promise<void>;
}
