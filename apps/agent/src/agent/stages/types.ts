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

export interface AgentSettingsView {
  tonePreset: string;
  toneGuidelinesExtra?: string;
  initialMessageTemplate?: string;
  handoffMessage?: string;
  companyKnowledge: Record<string, unknown>;
  companyDocuments: Array<{ name: string; url?: string; topics?: string[] }>;
  paymentMethods: Record<string, unknown>;
}

export interface StageHandler {
  readonly stage: Stage;
  handle(input: StageInput): Promise<StageDecision>;
}
