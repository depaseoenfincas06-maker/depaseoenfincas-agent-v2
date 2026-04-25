import type { Stage } from '@depf/shared';
import type { StageHandler } from './types.js';
import { qualifyingStage } from './qualifying.js';
import { offeringStage } from './offering.js';
import { verifyingStage } from './verifying.js';
import { confirmingStage } from './confirming.js';
import { hitlStage } from './hitl.js';
import { qaStage } from './qa.js';

const handlers: Record<Stage, StageHandler> = {
  QUALIFYING: qualifyingStage,
  OFFERING: offeringStage,
  VERIFYING_AVAILABILITY: verifyingStage,
  CONFIRMING_RESERVATION: confirmingStage,
  HITL: hitlStage,
};

export { qaStage };

export function getStageHandler(stage: Stage): StageHandler {
  const handler = handlers[stage];
  if (!handler) throw new Error(`No stage handler for: ${stage}`);
  return handler;
}

export type { StageHandler, StageInput, AgentSettingsView } from './types.js';
