import type { ConversationContext, Stage, StageDecision } from '@depf/shared';
import type { Trace } from '../../observability/tracer.js';

export interface StageInput {
  /** The text the user sent (transcribed if it was audio). */
  userText: string;
  /** The user's recent message history (latest first), for context. */
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>;
  /** Snapshot of the conversation context at the start of this turn. */
  conversation: ConversationContext;
  /** Settings (tone, prompts, knowledge base, etc.) */
  settings: AgentSettingsView;
  /** Trace handle so we can attach LLM calls + tool calls. */
  trace: Trace;
}

export interface PromptAddenda {
  global?: string | null;
  qualifying?: string | null;
  offering?: string | null;
  verifying?: string | null;
  qa?: string | null;
  hitl?: string | null;
  confirming?: string | null;
}

/**
 * View on agent_settings exposed to stage handlers. Read-only at the stage
 * level; persisted via the dashboard PUT /api/settings.
 */
export interface AgentSettingsView {
  tonePreset: string;
  toneGuidelinesExtra?: string;
  initialMessageTemplate?: string;
  handoffMessage?: string;
  companyKnowledge: Record<string, unknown> | string;
  companyDocuments: Array<{ name: string; url?: string; topics?: string[] }>;
  paymentMethods: unknown;
  // ---- v1-parity fields (wired to runtime) ----
  promptAddenda?: PromptAddenda;
  coverageZones?: string | null;
  publicAppBaseUrl?: string | null;
  maxPropertiesToShow?: number;
  globalBotEnabled?: boolean;
  ownerTestMode?: boolean;
  ownerContactOverride?: string | null;
  inventorySheetId?: string | null;
  inventorySheetTab?: string | null;
  // Sprint 4: WhatsApp template configuration
  selectionNotificationRecipients?: string | null;
  staffTemplateName?: string | null;
  staffTemplateLanguage?: string | null;
  ownerTemplateName?: string | null;
  ownerTemplateLanguage?: string | null;
}

export interface StageHandler {
  readonly stage: Stage;
  handle(input: StageInput): Promise<StageDecision>;
}

/**
 * Helper: build the tone block consistently across stages, splicing in the
 * global addendum so any "applies to all agents" instruction lands in every
 * stage prompt.
 */
export function buildToneBlock(s: AgentSettingsView): string {
  const parts: string[] = [];
  if (s.tonePreset) parts.push(s.tonePreset);
  if (s.toneGuidelinesExtra) parts.push(s.toneGuidelinesExtra);
  if (s.promptAddenda?.global) parts.push(s.promptAddenda.global);
  return parts.filter(Boolean).join('. ');
}

/**
 * Helper: append a stage-specific addendum to a system prompt. Stages call
 * this on their fully-templated system prompt right before passing to the LLM.
 */
export function withStageAddendum(
  systemPrompt: string,
  addendum?: string | null,
): string {
  if (!addendum || !addendum.trim()) return systemPrompt;
  return `${systemPrompt}\n\nINSTRUCCIONES ADICIONALES (configuradas desde el dashboard):\n${addendum.trim()}`;
}
