/**
 * Chatwoot adapter. Sends text + attachments via the public API.
 * Auth via static api_access_token header.
 */
import { request } from 'undici';
import type { OutboundMessage } from '@depf/shared';
import type { ChannelAdapter, SendResult } from './types.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

interface ChatwootMessageResponse {
  id?: number;
  source_id?: string;
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

  async send(conversationId: string, message: OutboundMessage): Promise<SendResult> {
    if (!config.CHATWOOT_API_TOKEN) {
      throw new Error('CHATWOOT_API_TOKEN not configured');
    }
    const url = `${this.baseUrl}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    // Attachments: Chatwoot wants multipart for media. For now we send text;
    // attachment upload is done via send-attachment in a later phase.
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

    const data = (await res.body.json()) as ChatwootMessageResponse;
    if (res.statusCode >= 400) {
      logger.error({ statusCode: res.statusCode, data }, 'chatwoot send failed');
      return { delivered: false, raw: data };
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
