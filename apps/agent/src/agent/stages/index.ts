import type { Stage } from '@depf/shared';
import type { StageHandler } from './types.js';
import { qualifyingStage } from './qualifying.js';

/**
 * Stage registry. As we port stages from the n8n workflow, register them here.
 * Stages NOT yet ported throw NotImplementedStage so callers can detect it.
 */

class NotImplementedStage implements StageHandler {
  constructor(public readonly stage: Stage) {}
  async handle(): Promise<never> {
    const err = new Error(`Stage handler not implemented: ${this.stage}`);
    (err as { kind?: string }).kind = 'not_implemented';
    throw err;
  }
}

const handlers: Record<Stage, StageHandler> = {
  QUALIFYING: qualifyingStage,
  OFFERING: new NotImplementedStage('OFFERING'),
  VERIFYING_AVAILABILITY: new NotImplementedStage('VERIFYING_AVAILABILITY'),
  CONFIRMING_RESERVATION: new NotImplementedStage('CONFIRMING_RESERVATION'),
  HITL: new NotImplementedStage('HITL'),
};

export function getStageHandler(stage: Stage): StageHandler {
  const handler = handlers[stage];
  if (!handler) throw new Error(`No stage handler for: ${stage}`);
  return handler;
}

export type { StageHandler, StageInput, AgentSettingsView } from './types.js';
