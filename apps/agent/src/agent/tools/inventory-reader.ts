/**
 * Tool exposed to the OFFERING stage. The LLM emits tool_calls with
 * `name: 'list_matching_fincas'` and we execute them server-side. Loop is
 * bounded in the stage handler — we never let the LLM "decide" to keep
 * calling. That's how Gemini hit Max iterations 4 in the n8n workflow.
 *
 * v1 parity (Sprint 1.2 wiring): the heavy lifting (zone aliases,
 * negation patterns, similar_items fallback, scoring) lives in
 * inventory/match.ts. This tool adapts the LLM's input shape to a
 * MatchInput and surfaces both `matches` and `similar_items` in the
 * output so the LLM can offer alternatives when the strict query
 * returns 0 ("no hay en Melgar pero tengo estas en Girardot").
 */
import { z } from 'zod';
import { loadFincas, getFincaById } from '../../inventory/loader.js';
import { matchInventory, type PublicListItem } from '../../inventory/match.js';

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

/**
 * Pull the photo URLs back onto each PublicListItem. v1's
 * sanitizeListItem only kept `foto_url` as a single comma-string. The card
 * builder needs `fotos` array too, so we re-attach by looking up the
 * matched finca in the loaded inventory.
 */
function enrichWithFotos(items: PublicListItem[], fincasById: Map<string, { fotos: string[]; foto_url?: string }>): Array<PublicListItem & { fotos?: string[] }> {
  return items.map((it) => {
    const finca = fincasById.get(it.finca_id);
    return {
      ...it,
      fotos: finca?.fotos ?? [],
      foto_url: it.foto_url ?? finca?.foto_url,
    };
  });
}

export async function executeInventoryTool(
  name: string,
  input: unknown,
  context?: { searchCriteria?: Record<string, unknown>; ownerContactOverride?: string },
): Promise<ToolExecutionResult> {
  try {
    const inventory = await loadFincas();
    const fincasById = new Map(inventory.map((f) => [f.fincaId, f]));

    if (name === 'list_matching_fincas') {
      const parsed = listMatchingFincasInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          error: `invalid input: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        };
      }

      // Adapt to MatchInput: match.ts wants a single zona string + the
      // search_criteria object that already holds zonas_excluidas etc.
      // The LLM passes zona as string|string[]; v1's matcher uses the
      // first entry as the primary zona and reads the array via
      // current_search_criteria.zona (which we populate below).
      const zonaArr = parsed.data.zona == null
        ? []
        : Array.isArray(parsed.data.zona)
          ? parsed.data.zona
          : [parsed.data.zona];
      const ciudadArr = parsed.data.ciudad == null
        ? []
        : Array.isArray(parsed.data.ciudad)
          ? parsed.data.ciudad
          : [parsed.data.ciudad];

      const mergedCriteria: Record<string, unknown> = {
        ...(context?.searchCriteria ?? {}),
        ...(zonaArr.length > 0 ? { zona: zonaArr } : {}),
        ...(ciudadArr.length > 0 ? { ciudad: ciudadArr } : {}),
        ...(parsed.data.amenidadesRequeridas
          ? { amenidades: parsed.data.amenidadesRequeridas }
          : {}),
        ...(parsed.data.presupuestoMax != null
          ? { presupuestoMax: parsed.data.presupuestoMax }
          : {}),
        ...(parsed.data.personas != null ? { personas: parsed.data.personas } : {}),
      };

      const result = matchInventory({
        operation: 'list_matching_fincas',
        inventory,
        zona: zonaArr[0] ?? '',
        ...(parsed.data.personas != null ? { personas: parsed.data.personas } : {}),
        ...(parsed.data.presupuestoMax != null
          ? { presupuesto_max: parsed.data.presupuestoMax }
          : {}),
        ...(parsed.data.limit != null ? { limit: parsed.data.limit } : {}),
        ...(parsed.data.excludeIds && parsed.data.excludeIds.length > 0
          ? { shown_fincas_json: JSON.stringify(parsed.data.excludeIds) }
          : {}),
        ...(context?.ownerContactOverride
          ? { owner_contact_override: context.ownerContactOverride }
          : {}),
        current_search_criteria: mergedCriteria,
        default_limit: 3,
      });

      const matchesEnriched = enrichWithFotos(result.items, fincasById);
      const similarEnriched = enrichWithFotos(result.similar_items, fincasById);

      return {
        ok: true,
        output: {
          matches: matchesEnriched,
          similar_items: similarEnriched,
          totalReturned: matchesEnriched.length,
          totalSimilar: similarEnriched.length,
          notes: result.notes,
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
      return {
        ok: true,
        output: {
          found: true,
          finca: {
            fincaId: finca.fincaId,
            codigo_original: finca.codigo_original ?? finca.fincaId,
            zona: finca.zona,
            ciudad: finca.ciudad,
            capacidadMin: finca.capacidadMin,
            capacidadMax: finca.capacidadMax,
            habitaciones: finca.habitaciones,
            precioPorNoche: finca.precioPorNoche,
            precio_noche_base: finca.precio_noche_base,
            precio_fin_semana: finca.precio_fin_semana,
            amenidades: finca.amenidades,
            mascotas: finca.mascotas,
            descripcionCorta: finca.descripcionCorta,
            observaciones_originales: finca.observaciones_originales,
            caracteristicas_originales: finca.caracteristicas_originales,
            foto_url: finca.foto_url,
            fotos: finca.fotos,
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
   output: {
     matches: FincaCardObject[],     // los que cumplen estrictamente los criterios
     similar_items: FincaCardObject[], // alternativas cercanas cuando matches está vacío o es chico
     totalReturned: number,
     totalSimilar: number,
     notes: string | null
   }

   ZONAS / CIUDADES SIN INVENTARIO (escenario "Melgar"):
   - Si pides "Melgar" y no tenemos fincas allá, el tool retorna matches=[]
     Y similar_items=[ ...fincas en zonas cercanas ].
   - En ese caso DEBES decirle al cliente: "No tenemos en Melgar, pero te muestro
     estas opciones cercanas:" y poner los similar_items en fincas_mostradas.
   - NUNCA respondas "no hay fincas" sin chequear similar_items primero.

   El matching de zona/ciudad es OR: una finca pasa si su zona matchea CUALQUIERA de las del array.

2. get_finca_details — info detallada de una finca específica.
   input: { fincaId: string }
   output: { found: boolean, finca?: FincaCardObject }
`.trim();
