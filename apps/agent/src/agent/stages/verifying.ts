/**
 * VERIFYING_AVAILABILITY stage. The client just chose a finca; we tell them
 * "estoy verificando disponibilidad con el propietario" and AUTO-LOOP into
 * CONFIRMING_RESERVATION immediately so we don't make them wait on the owner.
 *
 * The owner notification is queued asynchronously (selection_notifications
 * row → another worker handles staff comms). If the owner later rejects, an
 * admin endpoint flips a flag that bumps the conversation back to OFFERING.
 *
 * This handler responds to the client and transitions. It does NOT wait.
 */
import type { StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';
import { sendOwnerMessage } from '../../channels/whatsapp.js';
import { query } from '../../persistence/db.js';
import { logger } from '../../observability/logger.js';

class VerifyingStage implements StageHandler {
  readonly stage = 'VERIFYING_AVAILABILITY' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const selected = input.conversation.selectedFinca;
    if (!selected) {
      logger.warn(
        { conversationId: input.conversation.waId },
        'VERIFYING reached without selectedFinca — rolling back to OFFERING',
      );
      return {
        intent: 'NO_MATCH',
        extractedData: {},
        nextStage: 'OFFERING',
        outbound: [
          {
            channel: 'simulator',
            type: 'text',
            text: 'Algo no encajó con tu selección. ¿Me confirmas cuál finca te gustó?',
          },
        ],
        toolCalls: [],
        reasoning: 'no selected finca on entry to VERIFYING',
      };
    }

    // Queue owner notification + actually send if recipients are configured.
    // owner_test_mode short-circuits real sending so internal QA doesn't ping
    // real property owners. owner_contact_override redirects every send to
    // a single test number (legacy v1 field).
    const recipientsRaw = (input.conversation.extras as { selectionRecipients?: string[] } | undefined)?.selectionRecipients;
    const recipients =
      input.settings.ownerContactOverride && input.settings.ownerContactOverride.trim().length > 0
        ? [input.settings.ownerContactOverride.trim()]
        : recipientsRaw ?? [];

    await query(
      `INSERT INTO selection_notifications (conversation_id, selected_finca_id, status, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT DO NOTHING`,
      [
        input.conversation.waId,
        selected,
        input.settings.ownerTestMode ? 'skipped_test_mode' : 'pending',
        JSON.stringify({ stage: 'VERIFYING', recipients, ownerTestMode: !!input.settings.ownerTestMode }),
      ],
    );

    if (!input.settings.ownerTestMode && recipients.length > 0) {
      const text = `Hola, te escribimos de De Paseo en Fincas. Tenemos una nueva solicitud de reserva para ${selected}. ¿Nos confirmas por favor si está disponible?`;
      for (const phone of recipients) {
        const r = await sendOwnerMessage(phone, text);
        if (!r.ok) {
          logger.warn({ phone, selected }, 'owner whatsapp send failed; notification stays pending');
        }
      }
    }

    return {
      intent: 'WAITING_OWNER',
      extractedData: {},
      // Auto-loop: client experience is seamless.
      nextStage: 'CONFIRMING_RESERVATION',
      outbound: [
        {
          channel: 'simulator',
          type: 'text',
          text: 'Estoy verificando disponibilidad con el propietario. Mientras tanto, déjame pedirte unos datos para tener todo listo cuando confirme.',
        },
      ],
      toolCalls: [],
      reasoning: 'Owner notification queued; auto-loop to CONFIRMING.',
    };
  }
}

export const verifyingStage = new VerifyingStage();
