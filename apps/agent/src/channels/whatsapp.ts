/**
 * Meta WhatsApp Cloud API adapter. Mainly used for the typing indicator
 * (which Chatwoot doesn't propagate to the user's WhatsApp). Outbound text
 * goes through Chatwoot for human-handoff visibility.
 */
import { request } from 'undici';
import type { ChannelAdapter, SendResult, TypingPayload } from './types.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

class WhatsAppChannel implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;

  async send(): Promise<SendResult> {
    // We deliberately don't send text directly via Meta — Chatwoot is the system
    // of record for outbound messages. This adapter exists for typing + media.
    throw new Error('WhatsApp direct send not used; outbound goes via chatwoot adapter');
  }

  async showTyping(_conversationId: string, payload: TypingPayload): Promise<void> {
    if (!config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_ACCESS_TOKEN) return;
    if (!payload.inResponseTo || !payload.inResponseTo.startsWith('wamid.')) return;

    const url = `https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: payload.inResponseTo,
          typing_indicator: { type: 'text' },
        }),
        bodyTimeout: 5_000,
        headersTimeout: 5_000,
      });
      if (res.statusCode >= 400) {
        const data = await res.body.text();
        logger.warn({ statusCode: res.statusCode, data }, 'whatsapp typing failed');
      }
    } catch (err) {
      logger.warn({ err }, 'whatsapp typing error');
    }
  }
}

export const whatsappChannel = new WhatsAppChannel();
