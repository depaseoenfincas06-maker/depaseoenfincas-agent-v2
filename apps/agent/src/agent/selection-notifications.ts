/**
 * Selection notifications — fired when a customer picks a finca in OFFERING
 * (intent=CLIENT_CHOSE). Direct port of v1's `Prepare selection notifications`
 * + `Send selection notifications` sub-workflow.
 *
 * Flow per v1:
 *   1. The settings table holds a CSV `selection_notification_recipients`
 *      column (e.g. "+573001234567,+573109876543") — the staff phone
 *      numbers that should receive a heads-up.
 *   2. We send the WhatsApp template `staff_finca_selected_v1` (Meta
 *      pre-approved) to each recipient with parameters:
 *        {{1}} client name
 *        {{2}} client wa_id (so they can text them)
 *        {{3}} finca codigo_original
 *        {{4}} finca real name
 *   3. Failures per-recipient are logged but don't block the others.
 *
 * The function is best-effort — if the template doesn't exist or Meta
 * returns an error, we log and move on. The customer's experience is
 * unaffected.
 */
import type { Finca } from '../inventory/types.js';
import { sendTemplateMessage } from '../channels/whatsapp.js';
import { logger } from '../observability/logger.js';

export interface SelectionContext {
  clientName: string | null;
  clientWaId: string;
  finca: Finca;
  recipients: string[];
  templateName?: string;
  templateLanguage?: string;
}

/** Parse the settings.selection_notification_recipients column into an
 *  array of phone numbers. Accepts comma, semicolon, or newline separated.
 *  Drops empty entries; leaves the format otherwise untouched (Meta wants
 *  E.164 without the +; trust whoever configured the setting). */
export function parseRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim().replace(/^\+/, ''))
    .filter((s) => /^\d{10,15}$/.test(s));
}

export async function sendSelectionNotifications(ctx: SelectionContext): Promise<{
  attempted: number;
  delivered: number;
  failures: Array<{ to: string; reason: string }>;
}> {
  const recipients = ctx.recipients;
  if (recipients.length === 0) return { attempted: 0, delivered: 0, failures: [] };

  const templateName = ctx.templateName ?? 'staff_finca_selected_v1';
  const language = ctx.templateLanguage ?? 'es';
  const params = [
    { type: 'text' as const, text: ctx.clientName ?? 'Cliente' },
    { type: 'text' as const, text: ctx.clientWaId },
    { type: 'text' as const, text: ctx.finca.codigo_original ?? ctx.finca.fincaId },
    { type: 'text' as const, text: ctx.finca.realName ?? ctx.finca.fincaId },
  ];

  let delivered = 0;
  const failures: Array<{ to: string; reason: string }> = [];
  for (const to of recipients) {
    const result = await sendTemplateMessage('staff', to, templateName, language, params);
    if (result.ok) {
      delivered += 1;
    } else {
      failures.push({ to, reason: result.reason ?? 'unknown' });
      logger.warn(
        { to, reason: result.reason, templateName },
        'staff selection notification failed',
      );
    }
  }
  return { attempted: recipients.length, delivered, failures };
}
