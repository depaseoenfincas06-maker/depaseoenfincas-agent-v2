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

    // Queue owner notification asynchronously
    await query(
      `INSERT INTO selection_notifications (conversation_id, selected_finca_id, status, payload)
         VALUES ($1, $2, 'pending', $3::jsonb)
         ON CONFLICT DO NOTHING`,
      [input.conversation.waId, selected, JSON.stringify({ stage: 'VERIFYING' })],
    );

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
