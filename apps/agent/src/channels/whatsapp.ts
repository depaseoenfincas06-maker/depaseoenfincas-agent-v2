/**
 * Meta WhatsApp Cloud API adapter. Two roles:
 *   - CLIENT-facing (WHATSAPP_PHONE_NUMBER_ID): typing indicator + media
 *     forwarding for the main agent conversations.
 *   - OWNER-facing (WHATSAPP_OWNER_PHONE_NUMBER_ID): direct text messages
 *     to property owners to verify finca availability. We DO send text from
 *     this number because it's not in Chatwoot (those conversations are
 *     internal to the company).
 *
 * Outbound text on the CLIENT side still goes through Chatwoot for handoff
 * visibility — this adapter is not the primary text sender for clients.
 */
import { request } from 'undici';
import type { OutboundMessage } from '@depf/shared';
import type { ChannelAdapter, SendContext, SendResult, TypingPayload } from './types.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

const META_BASE = 'https://graph.facebook.com/v21.0';

interface MetaSendResponse {
  messages?: Array<{ id: string }>;
  [k: string]: unknown;
}

async function metaPost(phoneNumberId: string, body: Record<string, unknown>) {
  if (!config.WHATSAPP_ACCESS_TOKEN) {
    throw new Error('WHATSAPP_ACCESS_TOKEN not configured');
  }
  return request(`${META_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    bodyTimeout: 10_000,
    headersTimeout: 10_000,
  });
}

class WhatsAppChannel implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;

  async send(_ctx: SendContext): Promise<SendResult> {
    // Client-side outbound goes via Chatwoot for handoff visibility.
    throw new Error('WhatsApp direct send not used for clients; outbound goes via chatwoot adapter');
  }

  async showTyping(_ctx: SendContext, payload: TypingPayload): Promise<void> {
    if (!config.WHATSAPP_PHONE_NUMBER_ID) return;
    if (!payload.inResponseTo || !payload.inResponseTo.startsWith('wamid.')) return;
    try {
      const res = await metaPost(config.WHATSAPP_PHONE_NUMBER_ID, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: payload.inResponseTo,
        typing_indicator: { type: 'text' },
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

/**
 * Send a text message to a property owner (NOT a client). Used by the
 * VERIFYING_AVAILABILITY stage when notifying owners. Returns the wamid so
 * the response (or non-response) can be tracked via Meta webhooks.
 */
export async function sendOwnerMessage(toPhone: string, text: string): Promise<{ wamid?: string; ok: boolean }> {
  if (!config.WHATSAPP_OWNER_PHONE_NUMBER_ID) {
    logger.warn('WHATSAPP_OWNER_PHONE_NUMBER_ID not configured; skipping owner message');
    return { ok: false };
  }
  try {
    const res = await metaPost(config.WHATSAPP_OWNER_PHONE_NUMBER_ID, {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body: text },
    });
    const data = (await res.body.json()) as MetaSendResponse;
    if (res.statusCode >= 400) {
      logger.error({ statusCode: res.statusCode, data }, 'owner whatsapp send failed');
      return { ok: false };
    }
    return { wamid: data.messages?.[0]?.id, ok: true };
  } catch (err) {
    logger.error({ err }, 'owner whatsapp send error');
    return { ok: false };
  }
}

/**
 * Future: Send a media-rich message (image / document) to a client via Meta
 * directly. Not implemented yet — for now we let Chatwoot handle that path.
 */
export async function sendOwnerMediaMessage(_toPhone: string, _msg: OutboundMessage): Promise<{ ok: boolean }> {
  return { ok: false };
}

export type TemplateRole = 'client' | 'owner' | 'staff';

export interface TemplateParam {
  type: 'text' | 'currency' | 'date_time';
  text?: string;
  currency?: { code: string; amount_1000: number; fallback_value: string };
  date_time?: { fallback_value: string };
}

/**
 * Send a Meta WhatsApp template message. Templates must be pre-approved
 * inside Meta Business Manager. We use this for:
 *
 *   - staff_finca_selected_v1 — fired when a customer picks a finca, sends
 *     the team a notification with finca code + customer details.
 *   - solicitud_reserva — fired when the bot asks an owner to confirm
 *     availability for a reservation.
 *
 * The choice of phone_number_id depends on `role`:
 *   - 'client'/'staff' → WHATSAPP_PHONE_NUMBER_ID (the customer-facing line)
 *   - 'owner' → WHATSAPP_OWNER_PHONE_NUMBER_ID (the owner-facing line)
 *
 * Returns wamid so the receiver's reply can be linked back via webhook.
 */
export async function sendTemplateMessage(
  role: TemplateRole,
  toPhone: string,
  templateName: string,
  language: string,
  params: TemplateParam[],
): Promise<{ wamid?: string; ok: boolean; reason?: string }> {
  const phoneNumberId =
    role === 'owner'
      ? config.WHATSAPP_OWNER_PHONE_NUMBER_ID
      : config.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    return { ok: false, reason: `phone_number_id for role=${role} not configured` };
  }
  try {
    const res = await metaPost(phoneNumberId, {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: params.length > 0 ? [{ type: 'body', parameters: params }] : [],
      },
    });
    let data: MetaSendResponse = {};
    try {
      data = (await res.body.json()) as MetaSendResponse;
    } catch {
      /* ignore */
    }
    if (res.statusCode >= 400) {
      const reason = `meta ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`;
      logger.error({ statusCode: res.statusCode, data, role, templateName }, 'template send failed');
      return { ok: false, reason };
    }
    return { wamid: data.messages?.[0]?.id, ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, role, templateName }, 'template send error');
    return { ok: false, reason };
  }
}
