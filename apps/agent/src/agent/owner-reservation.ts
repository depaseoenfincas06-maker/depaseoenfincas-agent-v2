/**
 * Owner reservation request — fired when a customer picks a finca and we
 * need to confirm availability with the property owner. Direct port of v1's
 * `Fire owner reservation request` HTTP webhook + sub-workflow.
 *
 * Flow per v1:
 *   1. Look up `owner_contacto` (phone) on the chosen finca.
 *   2. Apply `owner_contact_override` from settings if test mode is on
 *      (so dev/staging doesn't ping real owners).
 *   3. Send the WhatsApp template `solicitud_reserva` from the owner-side
 *      Meta number (WHATSAPP_OWNER_PHONE_NUMBER_ID) with parameters:
 *        {{1}} owner name (or "propietario")
 *        {{2}} client wa_id (so the owner knows who's asking)
 *        {{3}} finca real name (this IS the owner-only context — they need
 *              to know which property the customer means; same name they
 *              gave us)
 *        {{4}} fechaInicio
 *        {{5}} fechaFin
 *        {{6}} personas
 *   4. Persist the wamid on the conversation.extras so when the owner
 *      replies via the owner inbox, we can correlate the response back to
 *      this request.
 *
 * This DOES NOT update conversation.owner_response — that happens when the
 * owner replies (Sprint 2 owner inbox handler). All this does is fire the
 * outbound template.
 */
import type { Finca } from '../inventory/types.js';
import { sendTemplateMessage } from '../channels/whatsapp.js';
import { logger } from '../observability/logger.js';

export interface OwnerReservationContext {
  finca: Finca;
  clientWaId: string;
  fechaInicio?: string;
  fechaFin?: string;
  personas?: number;
  ownerContactOverride?: string | null;
  testMode?: boolean;
  templateName?: string;
  templateLanguage?: string;
}

/** Resolve which phone number to actually message. In test mode the override
 *  always wins so we don't accidentally reach a real owner during dev. */
export function resolveOwnerTarget(ctx: OwnerReservationContext): string | null {
  if (ctx.testMode && ctx.ownerContactOverride) {
    const cleaned = ctx.ownerContactOverride.trim().replace(/^\+/, '');
    if (/^\d{10,15}$/.test(cleaned)) return cleaned;
  }
  if (ctx.ownerContactOverride) {
    const cleaned = ctx.ownerContactOverride.trim().replace(/^\+/, '');
    if (/^\d{10,15}$/.test(cleaned)) return cleaned;
  }
  const real = (ctx.finca.owner_contacto ?? '').trim().replace(/^\+/, '');
  if (/^\d{10,15}$/.test(real)) return real;
  return null;
}

export async function sendOwnerReservationRequest(
  ctx: OwnerReservationContext,
): Promise<{ ok: boolean; wamid?: string; to?: string; reason?: string }> {
  const to = resolveOwnerTarget(ctx);
  if (!to) {
    logger.warn(
      { fincaId: ctx.finca.fincaId, ownerContacto: ctx.finca.owner_contacto },
      'owner reservation request: no valid target phone — skipping',
    );
    return { ok: false, reason: 'no valid owner phone' };
  }

  const templateName = ctx.templateName ?? 'solicitud_reserva';
  const language = ctx.templateLanguage ?? 'es';
  const ownerName = ctx.finca.owner_nombre?.trim() || 'Propietario';
  const params = [
    { type: 'text' as const, text: ownerName },
    { type: 'text' as const, text: ctx.clientWaId },
    { type: 'text' as const, text: ctx.finca.realName ?? ctx.finca.fincaId },
    { type: 'text' as const, text: ctx.fechaInicio ?? 'sin definir' },
    { type: 'text' as const, text: ctx.fechaFin ?? 'sin definir' },
    { type: 'text' as const, text: String(ctx.personas ?? '?') },
  ];

  const result = await sendTemplateMessage('owner', to, templateName, language, params);
  if (!result.ok) {
    return { ok: false, to, reason: result.reason };
  }
  return { ok: true, to, ...(result.wamid ? { wamid: result.wamid } : {}) };
}
