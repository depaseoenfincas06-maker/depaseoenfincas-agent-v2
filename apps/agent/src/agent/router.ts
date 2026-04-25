/**
 * Router decides whether an inbound message goes to:
 *   - the QA agent (FAQ-style questions, regardless of stage)
 *   - the HITL escalation (user explicitly asked for a human, threats, etc.)
 *   - the current stage handler (the default)
 *
 * Strategy: deterministic regex pass first (fast, free, predictable for the
 * known FAQ surface), LLM classifier only if regex didn't match. The classifier
 * always returns a closed enum so we can't end up in an unhandled state.
 *
 * This kills the "¿Se pueden llevar mascotas?" → offering_agent → max iterations
 * bug: that question matches FAQ regex and goes to QA, not OFFERING.
 */
import { z } from 'zod';
import type { Stage, ConversationContext } from '@depf/shared';

export type RouteDestination = 'qa' | 'hitl' | 'stage';

export interface RouteDecision {
  destination: RouteDestination;
  reason: string;
  confidence: 'rule' | 'llm';
}

const HITL_PATTERNS: RegExp[] = [
  /\b(quiero|necesito|por favor)\s+(hablar|atender(?:me)?|que me atienda)\s+(con\s+)?(un\s+)?(humano|persona|asesor|agente|alguien)\b/i,
  /\bp[áa]same\s+con\s+(un\s+)?(humano|asesor|agente|persona|alguien)\b/i,
  /\bya\s+no\s+quiero\s+(este\s+)?bot\b/i,
  /\bd[ée]jeme\s+hablar\s+con\b/i,
  /\b(es)?\s*una\s+estafa\b/i,
  /\b(amenaz|demand|abogado|polic[ií]a)\w*/i,
];

const FAQ_PATTERNS: { pattern: RegExp; topic: string }[] = [
  { pattern: /\bmascot(?:a|as)\b/i, topic: 'mascotas' },
  { pattern: /\b(precio|tarifa|cost(?:o|os)|cu[áa]nto\s+(cuesta|vale|sale))/i, topic: 'precio' },
  { pattern: /\b(rut|c[áa]mara\s+de\s+comercio|nit|certificado)/i, topic: 'documentos' },
  { pattern: /\b(d[óo]nde\s+queda|c[óo]mo\s+llego|ubicaci[óo]n|direcci[óo]n)\b/i, topic: 'ubicacion' },
  { pattern: /\b(medio|forma)s?\s+de\s+pago\b/i, topic: 'pago' },
  { pattern: /\b(qu[ée]\s+incluye|qu[ée]\s+trae|qu[ée]\s+tiene)\b/i, topic: 'incluye' },
  { pattern: /\b(check[\s-]?in|hora\s+de\s+(llegada|salida))\b/i, topic: 'horarios' },
  { pattern: /\b(piscina|jacuzzi|chimenea|wifi|internet|parqueader|asad[oer])/i, topic: 'amenidad' },
];

export function applyDeterministicRules(text: string): RouteDecision | null {
  const t = text.trim();
  if (!t) return null;

  for (const re of HITL_PATTERNS) {
    if (re.test(t)) {
      return { destination: 'hitl', reason: 'HITL pattern matched', confidence: 'rule' };
    }
  }

  for (const { pattern, topic } of FAQ_PATTERNS) {
    if (pattern.test(t)) {
      return { destination: 'qa', reason: `FAQ topic: ${topic}`, confidence: 'rule' };
    }
  }

  return null;
}

export const llmRouterSchema = z.object({
  destination: z.enum(['qa', 'hitl', 'stage']),
  reason: z.string(),
});

export interface RouterContext {
  text: string;
  stage: Stage;
  conversation: ConversationContext;
}

/**
 * Build the prompt for the LLM router. Kept compact — the router is called
 * on every inbound, so token efficiency matters.
 */
export function buildRouterPrompt(ctx: RouterContext) {
  return [
    {
      role: 'system' as const,
      content: `Eres un router que decide a quién enviar el siguiente mensaje del cliente. Devuelve SOLO un JSON con {"destination": "qa"|"hitl"|"stage", "reason": "..."}.
Reglas:
- "qa": pregunta puntual de información (precios, mascotas, ubicación, qué incluye, documentos de empresa, horarios). NO toques el flujo principal.
- "hitl": el cliente pide humano explícitamente, está furioso, amenaza, hay disputa de pagos.
- "stage": cualquier otra cosa — sigue el flujo del stage actual.
Stage actual: ${ctx.stage}.`,
    },
    {
      role: 'user' as const,
      content: ctx.text,
    },
  ];
}
