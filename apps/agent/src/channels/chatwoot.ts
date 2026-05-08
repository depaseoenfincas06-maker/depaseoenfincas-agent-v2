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

    // Route by message type. Plain text → /messages JSON. Media → either
    // a sequence of attachment_urls (for image/document) or a multipart upload.
    if (message.type === 'media_group' || message.type === 'image' || message.type === 'document') {
      return this.sendMediaMessage(ctx, message);
    }

    return this.sendTextMessage(ctx, message);
  }

  /**
   * Send a plain text content message via the JSON endpoint. Returns the
   * Chatwoot message id so the caller can dedupe.
   */
  private async sendTextMessage(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const url = `${this.baseUrl}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${ctx.chatwootConversationId}/messages`;
    const body: Record<string, unknown> = {
      content: message.text ?? '',
      message_type: 'outgoing',
      private: false,
    };

    const res = await request(url, {
      method: 'POST',
      headers: {
        api_access_token: config.CHATWOOT_API_TOKEN!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    let data: ChatwootMessageResponse = {};
    try {
      data = (await res.body.json()) as ChatwootMessageResponse;
    } catch {
      // Some 4xx responses aren't JSON
    }

    if (res.statusCode >= 400) {
      const reason = `chatwoot ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`;
      logger.error({ statusCode: res.statusCode, data, url, waId: ctx.waId }, 'chatwoot text send failed');
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

  /**
   * Send a message with attachments. Chatwoot's API accepts:
   *   - For URLs already hosted somewhere public (Google Drive folder IDs etc):
   *     POST multipart/form-data with `attachment[]` set to the public URL.
   *   - For binary uploads, include the file as form-data part.
   *
   * For now we support URL attachments (the v1 finca cards reference Google
   * Drive folder URLs, which Meta WhatsApp dereferences and uploads itself
   * once the message goes through the integration). For binary blobs (e.g.
   * the reservation PDF generated locally) we use the `data:` URI scheme,
   * which Chatwoot accepts and converts.
   */
  private async sendMediaMessage(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      // No attachments → fall back to text-only
      if (message.text) return this.sendTextMessage(ctx, message);
      return { delivered: false, failureReason: 'media message has no attachments and no text' };
    }

    const url = `${this.baseUrl}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${ctx.chatwootConversationId}/messages`;

    // Build a multipart form body. Chatwoot expects the parts named
    // `content`, `message_type`, `private`, and `attachments[]`.
    const boundary = `----depf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const lines: Buffer[] = [];
    const enc = (s: string) => Buffer.from(s, 'utf8');
    const crlf = enc('\r\n');

    const append = (fieldName: string, value: string) => {
      lines.push(enc(`--${boundary}\r\n`));
      lines.push(enc(`Content-Disposition: form-data; name="${fieldName}"\r\n\r\n`));
      lines.push(enc(value));
      lines.push(crlf);
    };

    append('content', message.text ?? '');
    append('message_type', 'outgoing');
    append('private', 'false');

    // We can pass either a `attachments[]` field as a URL string for hosted
    // images (Chatwoot fetches it server-side), or we can fetch it ourselves
    // and upload as binary. Hosted URL is simpler — try that first.
    for (const att of attachments) {
      if (att.url) {
        append('attachment_url[]', att.url);
      } else if (att.data) {
        // Decode base64 and append as a file part
        const buffer = Buffer.from(att.data, 'base64');
        const filename = att.filename ?? 'attachment';
        const mimeType = att.mimeType ?? 'application/octet-stream';
        lines.push(enc(`--${boundary}\r\n`));
        lines.push(enc(`Content-Disposition: form-data; name="attachments[]"; filename="${filename}"\r\n`));
        lines.push(enc(`Content-Type: ${mimeType}\r\n\r\n`));
        lines.push(buffer);
        lines.push(crlf);
      }
    }

    lines.push(enc(`--${boundary}--\r\n`));
    const body = Buffer.concat(lines);

    const res = await request(url, {
      method: 'POST',
      headers: {
        api_access_token: config.CHATWOOT_API_TOKEN!,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    let data: ChatwootMessageResponse = {};
    try {
      data = (await res.body.json()) as ChatwootMessageResponse;
    } catch {
      // ignore
    }

    if (res.statusCode >= 400) {
      const reason = `chatwoot media ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`;
      logger.error({ statusCode: res.statusCode, data, url, waId: ctx.waId }, 'chatwoot media send failed');
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
