/**
 * Owner inbox handler — direct port of v1's `Handle owner inbound`
 * sub-workflow (W5fO8QiAMlYyIlCb). When a property owner replies via
 * WhatsApp to a `solicitud_reserva` template, the message lands in
 * Chatwoot's owner inbox (different from the customer-facing inbox).
 * We need to:
 *
 *   1. Detect that the inbound came from the owner inbox (config flag).
 *   2. Parse the text for a sí/no availability signal.
 *   3. Find the matching client conversation (by selected_finca's
 *      owner_contacto matching the sender wa_id).
 *   4. Update conversations.owner_response = {disponible, message,
 *      respondedAt} on the client side.
 *   5. Trigger the bot to follow up with the customer (Sprint 2.4 will
 *      enqueue a synthetic inbound so the deterministic prechecks run).
 *
 * For now (Sprint 2.3 partial), step 5 isn't wired — we just persist
 * owner_response. The customer's NEXT inbound will see the new state and
 * the precheck logic will route accordingly.
 */
import { pool } from '../persistence/db.js';
import { getFincaByOwnerPhone } from '../inventory/loader.js';
import { logger } from '../observability/logger.js';

export interface OwnerInboundResult {
  matched: boolean;
  reason: string;
  clientWaId?: string;
  fincaId?: string;
  disponible?: boolean;
}

/** Match common Spanish affirmation/negation phrases for availability.
 *  Returns true/false/null (null = ambiguous, leave for human review). */
export function parseAvailability(text: string): boolean | null {
  const t = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  // Strong NO signals checked FIRST (so "no disponible" doesn't false-match
  // the "disponible" affirmative).
  if (
    /\b(no\s+disponible|no\s+esta\s+disponible|no\s+puedo|no\s+queda|reservada|ocupada|no\s+hay\s+disponibilidad|imposible)\b/.test(
      t,
    )
  ) {
    return false;
  }
  if (/^(no|nop|nope|nada)\b/.test(t)) return false;
  // Positive signals
  if (
    /\b(disponible|esta\s+disponible|si\s+disponible|reservada\s+no|si\s+puedo|claro|por\s+supuesto|ok\s+con\s+gusto|si\s+sin\s+problema)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(si|sii+|claro|listo|dale|ok|okay|vale)\b/.test(t)) return true;
  return null;
}

/**
 * Process an owner inbound. Returns whether we successfully linked it
 * to a client conversation and updated owner_response.
 */
export async function handleOwnerInbound(
  ownerWaId: string,
  text: string | null | undefined,
): Promise<OwnerInboundResult> {
  if (!text || !text.trim()) {
    return { matched: false, reason: 'empty owner message — nothing to parse' };
  }

  const finca = await getFincaByOwnerPhone(ownerWaId);
  if (!finca) {
    return {
      matched: false,
      reason: `no finca with owner_contacto matching ${ownerWaId.slice(-6)}`,
    };
  }

  // Find the most recent client conversation that selected this finca.
  // We trust the most-recent because if multiple clients are pending on
  // the same property, only the most recent is the one we're awaiting
  // (v1 behaviour — each new pending request supersedes the prior).
  const r = await pool.query<{ wa_id: string }>(
    `SELECT wa_id FROM conversations
       WHERE selected_finca = $1
         AND current_stage IN ('VERIFYING_AVAILABILITY','CONFIRMING_RESERVATION','OFFERING')
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
    [finca.fincaId],
  );
  const clientWaId = r.rows[0]?.wa_id;
  if (!clientWaId) {
    return {
      matched: false,
      reason: `no client conversation has selected_finca=${finca.fincaId}`,
      fincaId: finca.fincaId,
    };
  }

  const disponible = parseAvailability(text);
  const ownerResponse = {
    disponible,
    message: text.trim(),
    respondedAt: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE conversations SET owner_response = $2::jsonb WHERE wa_id = $1`,
    [clientWaId, JSON.stringify(ownerResponse)],
  );

  logger.info(
    { clientWaId, fincaId: finca.fincaId, disponible, ownerWaId: ownerWaId.slice(-6) },
    'owner inbound applied to client conversation',
  );

  return {
    matched: true,
    reason: `owner_response set on ${clientWaId} (disponible=${disponible})`,
    clientWaId,
    fincaId: finca.fincaId,
    ...(disponible !== null ? { disponible } : {}),
  };
}
