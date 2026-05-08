/**
 * Search-criteria normalisation — direct port of v1's `compactCriteria`,
 * `mergeCriteriaWithCurrent`, `uniqueCriteriaArray`, `normalizeCriteriaEntry`
 * from `Code in JavaScript1`.
 *
 * The LLM emits `extracted_data` per turn. Each turn we need to merge it
 * with the conversation's current `search_criteria` so multi-turn
 * accumulation works — but with these v1 invariants:
 *
 *   - Zona/ciudad/amenidades are arrays. Merge = union of stable strings,
 *     deduplicated case- and accent-insensitively.
 *   - The LLM occasionally re-states existing criteria (e.g. "Carmen" again
 *     after the user said "y también Girardot"). Dedup must catch that.
 *   - When the user says "ya no importa Carmen" the LLM MAY emit
 *     `zona_remove: ["Carmen"]` — we honour that and remove from the merged
 *     array. (See aliases.ts clearPatternTemplates for detection.)
 *   - Empty arrays are never persisted (we drop the key entirely so the
 *     persisted JSONB doesn't grow stale empty fields).
 *   - Numeric fields (personas, presupuestoMax) are not arrays — last write
 *     wins, but only if the new value is positive.
 */

const ARRAY_KEYS = new Set(['zona', 'ciudad', 'amenidades', 'tipoEvento']);

/** Normalise a single value: trim + collapse whitespace + drop "" */
function compactString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length > 0 ? t : null;
}

/** NFD-strip accents + lowercase — used as the dedup key, not the stored
 *  value. We always preserve the user's original casing/accents in the
 *  output array. */
function dedupKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Return a deduplicated array of compacted strings, preserving first-seen
 *  order (so the user-facing display is stable). */
export function uniqueCriteriaArray(values: unknown): string[] {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const compact = compactString(raw);
    if (!compact) continue;
    const key = dedupKey(compact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(compact);
  }
  return out;
}

/** Drop empty arrays / nullish values / non-positive numbers. Returns a
 *  shallow copy with only the surviving keys. */
export function compactCriteria(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    if (ARRAY_KEYS.has(k)) {
      const arr = uniqueCriteriaArray(v);
      if (arr.length > 0) out[k] = arr;
      continue;
    }
    if (k === 'personas' || k === 'presupuestoMax') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
      continue;
    }
    if (k === 'mascotas') {
      if (typeof v === 'boolean') out[k] = v;
      continue;
    }
    if (typeof v === 'string') {
      const c = compactString(v);
      if (c) out[k] = c;
      continue;
    }
    // pass-through for anything else (e.g. fechaInicio ISO string, tipoEvento
    // already compacted, future extensions)
    out[k] = v;
  }
  return out;
}

/** Subtract `remove` from `arr`, comparing via dedupKey. Order-preserving. */
function arrayDifference(arr: string[], remove: unknown): string[] {
  const removeKeys = new Set(uniqueCriteriaArray(remove).map(dedupKey));
  if (removeKeys.size === 0) return arr;
  return arr.filter((v) => !removeKeys.has(dedupKey(v)));
}

/**
 * Merge a freshly extracted criteria patch with the conversation's current
 * persisted criteria. Behaviour per key type:
 *
 *   array key:
 *     - if patch has `<key>_remove` → subtract those from current
 *     - if patch has `<key>` → union with current (deduped), unless patch
 *       came with `<key>_replace: true`, in which case patch fully replaces
 *     - if patch has neither → keep current
 *
 *   numeric/boolean/string key:
 *     - patch wins if it has a value; current preserved otherwise
 *
 * Returns a brand-new compacted object — never mutates inputs. The merged
 * result is what we persist to `conversations.search_criteria`.
 */
export function mergeCriteriaWithCurrent(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const c = compactCriteria(current ?? {});
  const p = patch ?? {};

  // Start from a copy of current, then apply the patch key by key.
  const out: Record<string, unknown> = { ...c };

  for (const key of ARRAY_KEYS) {
    const removeKey = `${key}_remove`;
    const replaceFlag = `${key}_replace`;
    const hasPatch = key in p;
    const hasRemove = removeKey in p;
    const isReplace = Boolean(p[replaceFlag]);

    let merged = (out[key] as string[] | undefined) ?? [];
    if (hasRemove) {
      merged = arrayDifference(merged, p[removeKey]);
    }
    if (hasPatch) {
      const fromPatch = uniqueCriteriaArray(p[key]);
      merged = isReplace
        ? fromPatch
        : uniqueCriteriaArray([...merged, ...fromPatch]);
    }
    if (merged.length > 0) {
      out[key] = merged;
    } else if (key in out) {
      delete out[key];
    }
  }

  // Scalars: numeric, boolean, string. Patch wins when defined.
  for (const k of ['personas', 'presupuestoMax']) {
    if (k in p) {
      const n = Number(p[k]);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
  }
  if ('mascotas' in p && typeof p.mascotas === 'boolean') {
    out.mascotas = p.mascotas;
  }
  for (const k of ['fechaInicio', 'fechaFin']) {
    if (k in p) {
      const s = compactString(p[k]);
      if (s) out[k] = s;
    }
  }

  return compactCriteria(out);
}
