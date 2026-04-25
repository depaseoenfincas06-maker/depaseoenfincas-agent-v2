/**
 * HITL stage — when the conversation has been escalated. The agent is
 * deactivated (`agente_activo=false`) outside this handler; this handler
 * only fires if the user keeps writing AFTER the escalation. We respond
 * once with a short "ya te contacta un asesor" message and stay silent.
 *
 * In practice the orchestrator short-circuits when agente_activo=false, so
 * this handler is mostly a safety net.
 */
import type { StageDecision } from '@depf/shared';
import type { StageHandler, StageInput } from './types.js';

class HITLStage implements StageHandler {
  readonly stage = 'HITL' as const;

  async handle(input: StageInput): Promise<StageDecision> {
    const message =
      input.settings.handoffMessage ??
      'Ya un asesor humano se está encargando de tu caso, te contactará en breve. ¡Gracias por tu paciencia!';
    return {
      intent: 'HITL_REQUEST',
      extractedData: {},
      nextStage: 'HITL',
      outbound: [{ channel: 'simulator', type: 'text', text: message }],
      toolCalls: [],
      reasoning: 'HITL stage — handoff message',
    };
  }
}

export const hitlStage = new HITLStage();
