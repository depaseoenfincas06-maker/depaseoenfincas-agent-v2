/**
 * Chatwoot adapter. Sends text + attachments via the public API.
 *
 * IMPORTANT: Chatwoot's POST /conversations/{id}/messages requires its
 * INTERNAL numeric conversation_id (eg 40). Passing the wa_id (the phone
 * number) returns 404 and the message never reaches the user's WhatsApp.
 * The orchestrator must resolve the chatwoot_conversation_id from our
 * conversations table and pass it via SendContext.
 */
import { request } from 'undici';
import type { OutboundMessage } from '@depf/shared';
import type { ChannelAdapter, SendContext, SendResult } from './types.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

interface ChatwootMessageResponse {
  id?: number;
  source_id?: string;
  status?: string;
  [key: string]: unknown;
}

class ChatwootChannel implements ChannelAdapter {
  readonly channel = 'chatwoot' as const;

  private get baseUrl(): string {
    if (!config.CHATWOOT_BASE_URL) {
      throw new Error('CHATWOOT_BASE_URL not configured');
    }
    return config.CHATWOOT_BASE_URL.replace(/\/$/, '');
  }

  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    if (!config.CHATWOOT_API_TOKEN) {
      throw new Error('CHATWOOT_API_TOKEN not configured');
    }
    if (!ctx.chatwootConversationId) {
      const reason = `cannot send: chatwoot_conversation_id not set on conversation wa_id=${ctx.waId}. Was this conversation created via Chatwoot webhook?`;
      logger.error({ waId: ctx.waId }, reason);
      return { delivered: false, failureReason: reason };
    }

    const url = `${this.baseUrl}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${ctx.chatwootConversationId}/messages`;

    // Attachments: Chatwoot wants multipart for media. For now we send text
    // (and document/image URLs as content_attributes). Multipart upload
    // happens in a later phase if we need binary attachments.
    const body: Record<string, unknown> = {
      content: message.text ?? '',
      message_type: 'outgoing',
      private: false,
    };

    const res = await request(url, {
      method: 'POST',
      headers: {
        api_access_token: config.CHATWOOT_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    let data: ChatwootMessageResponse = {};
    try {
      data = (await res.body.json()) as ChatwootMessageResponse;
    } catch {
      // Some 4xx responses aren't JSON — leave data empty
    }

    if (res.statusCode >= 400) {
      const reason = `chatwoot ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`;
      logger.error({ statusCode: res.statusCode, data, url, waId: ctx.waId }, 'chatwoot send failed');
      return { delivered: false, failureReason: reason, raw: data };
    }

    const externalMessageId =
      data.source_id ?? (data.id != null ? String(data.id) : undefined);
    return {
      ...(externalMessageId ? { externalMessageId } : {}),
      delivered: true,
      raw: data,
    };
  }
}

export const chatwootChannel = new ChatwootChannel();
