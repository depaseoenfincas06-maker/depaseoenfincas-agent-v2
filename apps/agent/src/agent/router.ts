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
import { getLLM } from './llm/index.js';
import { Trace } from '../observability/tracer.js';

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

  // Very short affirmations / negations / confirmations skip the LLM router
  // entirely — they're always continuations of the current stage flow.
  // Sending "si dale" through the QA classifier was producing malformed
  // JSON (token-truncated) which then fell through to fallback.
  if (
    /^(si|s[ií]+|nop?e?|ok|okay|listo|dale|dame|claro|por\s+supuesto|de\s+una|vale|perfecto|bueno|hecho)\b/i.test(
      t,
    ) &&
    t.length < 30
  ) {
    return { destination: 'stage', reason: 'short affirmation/confirmation', confidence: 'rule' };
  }

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

const llmRouterSchema = z.object({
  destination: z.enum(['qa', 'hitl', 'stage']),
  reason: z.string(),
});

export interface RouterContext {
  text: string;
  stage: Stage;
  conversation: ConversationContext;
  trace: Trace;
}

/**
 * LLM fallback router — called only when deterministic rules don't match.
 * Always returns a valid destination thanks to schema validation; if the
 * LLM call fails, we default to 'stage' (let current stage handle it),
 * never to a silent state.
 */
export async function applyLLMRouter(ctx: RouterContext): Promise<RouteDecision> {
  let llm;
  try {
    llm = getLLM();
  } catch (err) {
    await ctx.trace.recordTurn({
      stage: 'router',
      model: 'unknown',
      prompt: { text: ctx.text },
      response: null,
      toolsCalled: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      status: 'error',
      errorDetail: { message: err instanceof Error ? err.message : String(err) },
    });
    return { destination: 'stage', reason: 'LLM not configured', confidence: 'llm' };
  }
  const messages = [
    {
      role: 'system' as const,
      content: `Eres el QA Validator de "De Paseo en Fincas". Antes de que el agente principal responda, decides si el siguiente mensaje del cliente es:

  - "qa": una PREGUNTA PUNTUAL que se responde con conocimiento de la empresa (precios, mascotas, ubicación, qué incluye una finca, métodos de pago, documentos, horarios, políticas de cancelación, hora de check-in/out, ¿cuántos baños?, ¿hay piscina?). El cliente quiere INFORMACIÓN, no avanzar el flujo. Después de QA seguimos en el mismo state.

  - "hitl": el cliente pide hablar con humano explícitamente ("quiero hablar con alguien", "pásame con un asesor"), está enfurecido, amenaza con dejar review negativo, hay disputa de pagos, o pide algo legal/contractual fuera del flujo del bot.

  - "stage": cualquier otra cosa — el cliente está avanzando el flujo (eligiendo finca, dando datos, confirmando, ajustando criterios, saludando, dando fechas/personas/zona, seleccionando una finca por código).

REGLAS CRÍTICAS:
- Si el cliente menciona un código de finca ("la 9", "PEREIRA #03", "F005") → "stage" (está eligiendo).
- Si el cliente da fechas, número de personas o destino → "stage" (está calificando).
- Si el cliente da datos personales (nombre, cédula, teléfono, email) → "stage" (está confirmando).
- Una pregunta como "¿incluye limpieza?" o "¿cuál es la dirección?" → "qa" (información sobre el servicio).
- "Mejor háblame mañana" o "no estoy interesado" → "hitl" (cancelación).

Stage actual del flujo: ${ctx.stage}.

Devuelve SOLO un JSON: {"destination": "qa"|"hitl"|"stage", "reason": "<una frase>"}.`,
    },
    {
      role: 'user' as const,
      content: ctx.text,
    },
  ];
  try {
    const result = await llm.generate({
      name: 'intent-router',
      messages,
      schema: llmRouterSchema,
      temperature: 0,
      maxTokens: 200,
    });
    await ctx.trace.recordTurn({
      stage: 'router',
      model: result.model,
      prompt: messages,
      response: result.data,
      toolsCalled: [],
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      costUsd: result.usage.costUsd,
      latencyMs: result.latencyMs,
      status: 'ok',
    });
    return { ...result.data, confidence: 'llm' };
  } catch (err) {
    await ctx.trace.recordTurn({
      stage: 'router',
      model: 'unknown',
      prompt: messages,
      response: null,
      toolsCalled: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      status: 'error',
      errorDetail: { message: err instanceof Error ? err.message : String(err) },
    });
    // Fail-open to stage — never silently drop the message.
    return { destination: 'stage', reason: 'router LLM failed, defaulting to stage', confidence: 'llm' };
  }
}
