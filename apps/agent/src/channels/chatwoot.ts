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

/** Pick a file extension matching the MIME type so Chatwoot can re-derive
 *  the correct attachment_type (image/video/file). Defaults to .bin. */
function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('mpeg') || m.includes('audio')) return 'mp3';
  return 'bin';
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
   * Send a message with attachments. Chatwoot's API requires BINARY uploads
   * via multipart/form-data with `attachments[]` file parts — there is no
   * official "give me a URL and fetch it server-side" mechanism in the
   * standard Cloud or self-hosted versions. So we fetch the URL ourselves
   * (typically Google Drive direct-link URLs from the inventory sheet),
   * stream the bytes into the form, and let Chatwoot relay them onward to
   * Meta WhatsApp.
   *
   * For attachments already supplied as base64 (`data` field) — like the
   * reservation PDF generated locally — we decode and attach directly,
   * skipping the network fetch.
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
    // `content`, `message_type`, `private`, and `attachments[]` (binary).
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

    const appendBinary = (
      fieldName: string,
      filename: string,
      mimeType: string,
      buffer: Buffer,
    ) => {
      lines.push(enc(`--${boundary}\r\n`));
      lines.push(
        enc(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`),
      );
      lines.push(enc(`Content-Type: ${mimeType}\r\n\r\n`));
      lines.push(buffer);
      lines.push(crlf);
    };

    append('content', message.text ?? '');
    append('message_type', 'outgoing');
    append('private', 'false');

    // Fetch each URL attachment in parallel and then append as binary parts.
    // We bound each fetch with a 15s timeout — if a photo URL is slow we'd
    // rather drop it than block the whole reply. Failures are logged but
    // the message still goes out with whatever attachments did succeed.
    const fetched = await Promise.all(
      attachments.map(async (att, idx) => {
        if (att.data) {
          // Already base64 — decode and use directly
          return {
            ok: true as const,
            buffer: Buffer.from(att.data, 'base64'),
            filename: att.filename ?? `attachment-${idx + 1}`,
            mimeType: att.mimeType ?? 'application/octet-stream',
          };
        }
        if (!att.url) return { ok: false as const, reason: 'no url and no data' };
        try {
          const r = await request(att.url, {
            method: 'GET',
            headersTimeout: 15_000,
            bodyTimeout: 15_000,
          });
          if (r.statusCode < 200 || r.statusCode >= 300) {
            return { ok: false as const, reason: `fetch ${att.url} → ${r.statusCode}` };
          }
          const arrayBuf = await r.body.arrayBuffer();
          const ct = String(r.headers['content-type'] ?? att.mimeType ?? 'image/jpeg').split(';')[0]!.trim();
          const ext = mimeToExt(ct);
          return {
            ok: true as const,
            buffer: Buffer.from(arrayBuf),
            filename: att.filename ?? `photo-${idx + 1}.${ext}`,
            mimeType: ct,
          };
        } catch (err) {
          return {
            ok: false as const,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    let appendedCount = 0;
    for (const item of fetched) {
      if (item.ok) {
        appendBinary('attachments[]', item.filename, item.mimeType, item.buffer);
        appendedCount += 1;
      } else {
        logger.warn({ reason: item.reason, waId: ctx.waId }, 'attachment fetch failed — skipping');
      }
    }

    if (appendedCount === 0) {
      // No attachments resolved — fall back to text-only so the user still
      // sees the card content. Better than silence.
      if (message.text) {
        return this.sendTextMessage(ctx, message);
      }
      return {
        delivered: false,
        failureReason: 'all attachment fetches failed and no fallback text',
      };
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

  /**
   * PATCH custom_attributes on a Chatwoot conversation. Used by the
   * ia_activa sync: when the agent locally changes agente_activo on a
   * conversation (e.g. customer asks to talk to a human → HITL → flip to
   * false), we propagate that to Chatwoot so the team sees the same flag.
   *
   * Endpoint: PATCH /api/v1/accounts/{aid}/conversations/{cid}/custom_attributes
   * Body: { custom_attributes: { ia_activa: boolean } }
   *
   * Best-effort. If Chatwoot is down or the conversation doesn't exist, we
   * log + swallow — the local row is the source of truth for runtime, and
   * a later webhook will reconcile.
   */
  async patchCustomAttributes(
    chatwootConversationId: number,
    attributes: Record<string, unknown>,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!config.CHATWOOT_API_TOKEN) {
      return { ok: false, reason: 'CHATWOOT_API_TOKEN not configured' };
    }
    const url = `${this.baseUrl}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/custom_attributes`;
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          api_access_token: config.CHATWOOT_API_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ custom_attributes: attributes }),
      });
      if (res.statusCode >= 400) {
        let bodyText = '';
        try {
          bodyText = await res.body.text();
        } catch {
          /* ignore */
        }
        const reason = `chatwoot patch_custom_attributes ${res.statusCode}: ${bodyText.slice(0, 200)}`;
        logger.warn(
          { statusCode: res.statusCode, url, chatwootConversationId },
          'chatwoot custom_attributes patch failed',
        );
        return { ok: false, reason };
      }
      // Drain body so the connection is freed.
      try {
        await res.body.text();
      } catch {
        /* ignore */
      }
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err, chatwootConversationId }, 'chatwoot custom_attributes patch threw');
      return { ok: false, reason };
    }
  }
}

export const chatwootChannel = new ChatwootChannel();
