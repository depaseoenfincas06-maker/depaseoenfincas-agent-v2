/**
 * Tool exposed to the OFFERING stage. The LLM emits tool_calls with
 * `name: 'list_matching_fincas'` and we execute them server-side. Loop is
 * bounded in the stage handler — we never let the LLM "decide" to keep
 * calling. That's how Gemini hit Max iterations 4 in the n8n workflow.
 */
import { z } from 'zod';
import { matchFincas, getFincaById } from '../../inventory/loader.js';
import type { FincaMatch } from '../../inventory/types.js';

// Accept either a single string or an array (OR matching). Normalize inside.
const zonaInput = z.union([z.string(), z.array(z.string())]).optional();

export const listMatchingFincasInputSchema = z.object({
  personas: z.number().optional(),
  zona: zonaInput,
  ciudad: zonaInput,
  presupuestoMax: z.number().optional(),
  amenidadesRequeridas: z.array(z.string()).optional(),
  mascotas: z.boolean().optional(),
  excludeIds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export const getFincaDetailsInputSchema = z.object({
  fincaId: z.string(),
});

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export async function executeInventoryTool(
  name: string,
  input: unknown,
): Promise<ToolExecutionResult> {
  try {
    if (name === 'list_matching_fincas') {
      const parsed = listMatchingFincasInputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
      }
      const matches = await matchFincas(parsed.data);
      // Return ONLY the public view — no realName, no raw row.
      return {
        ok: true,
        output: {
          matches: matches.map((m: FincaMatch) => ({
            ...m.publicView,
            score: m.score,
            reasons: m.reasons,
          })),
          totalReturned: matches.length,
        },
      };
    }
    if (name === 'get_finca_details') {
      const parsed = getFincaDetailsInputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: 'invalid input' };
      }
      const finca = await getFincaById(parsed.data.fincaId);
      if (!finca) return { ok: true, output: { found: false } };
      // For the OFFERING stage we still don't reveal realName. The CONFIRMING
      // stage uses a separate, internal accessor.
      return {
        ok: true,
        output: {
          found: true,
          finca: {
            fincaId: finca.fincaId,
            zona: finca.zona,
            ciudad: finca.ciudad,
            capacidadMin: finca.capacidadMin,
            capacidadMax: finca.capacidadMax,
            precioPorNoche: finca.precioPorNoche,
            precioPorPersona: finca.precioPorPersona,
            amenidades: finca.amenidades,
            mascotas: finca.mascotas,
            descripcionCorta: finca.descripcionCorta,
            fotosCount: finca.fotos.length,
          },
        },
      };
    }
    return { ok: false, error: `unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const INVENTORY_TOOL_DESCRIPTIONS = `
Tools disponibles en este stage:

1. list_matching_fincas — busca fincas que matcheen criterios.
   input: {
     personas?: number,
     zona?: string | string[],     // si el cliente menciona varias ("Carmen O Girardot"), pasa array ["Carmen","Girardot"]
     ciudad?: string | string[],
     presupuestoMax?: number,
     amenidadesRequeridas?: string[],
     mascotas?: boolean,
     excludeIds?: string[],         // SIEMPRE incluye las fincas ya mostradas (shown_fincas)
     limit?: number
   }
   output: { matches: PublicFincaView[], totalReturned: number }
   El matching de zona/ciudad es OR: una finca pasa si su zona matchea CUALQUIERA de las del array.

2. get_finca_details — info detallada de una finca específica.
   input: { fincaId: string }
   output: { found: boolean, finca?: PublicFincaView }
`.trim();
