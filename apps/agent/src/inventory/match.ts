/**
 * Inventory matching engine — direct port of the n8n `Build Inventory Tool
 * Response` node (~600 lines). The logic is intentionally faithful: same
 * scoring, same exclusions, same similar_items fallback. If we change the
 * heuristic we change matching behavior, which affects which fincas the
 * agent shows in OFFERING. Don't touch the scoring weights without an eval.
 *
 * Three operations exposed:
 *   - list_matching_fincas: rank candidates by criteria
 *   - get_finca_details: return one specific finca
 *   - get_owner_contact: return the owner's contact for a given finca
 *
 * Inputs come from the LLM (via the inventory_reader tool) plus context the
 * orchestrator already has (search_criteria, shown_fincas, selected_finca).
 */
import type { Finca } from './types.js';
import {
  amenityAliasDefinitions,
  clearPatternTemplates,
  detectAmenityValuesFromMessage,
  detectMunicipioValuesFromMessage,
  detectZoneValuesFromMessage,
  negativePatternTemplates,
  normalizeText,
  resolveAmenityAlias,
  resolveLocationExpressionTargets,
  resolveZoneAlias,
  uniqueValues,
} from './aliases.js';

export type Operation = 'list_matching_fincas' | 'get_finca_details' | 'get_owner_contact';

export interface MatchInput {
  operation: Operation;
  finca_id?: string;
  selected_finca_id?: string;
  selected_finca_nombre?: string;
  nombre?: string;
  query?: string;
  zona?: string;
  context_zona?: string;
  personas?: number | string;
  context_personas?: number | string;
  presupuesto_max?: number | string;
  context_presupuesto_max?: number | string;
  context_fecha_inicio?: string;
  context_fecha_fin?: string;
  limit?: number;
  shown_fincas_json?: string;
  /** From settings — used to override owner_contacto in test mode */
  owner_contact_override?: string;
  /** Inventory loaded by the caller (so we don't double-fetch). */
  inventory: Finca[];
  /** From conversations.search_criteria. */
  current_search_criteria?: Record<string, unknown>;
  /** Hard limit fallback (settings.max_properties_to_show). */
  default_limit?: number;
}

export interface PublicListItem {
  finca_id: string;
  nombre: string;
  codigo_original?: string;
  zona?: string;
  municipio?: string;
  capacidad_max?: number;
  capacidad_minima_tarifa?: number;
  habitaciones?: number;
  min_noches?: number;
  precio_noche_base?: number;
  precio_fin_semana?: number;
  precio_festivo?: number;
  precio_semana_santa_receso?: number;
  precio_temporada_alta?: number;
  precio_persona_extra?: number;
  precio_referencia_noche?: number | null;
  pet_friendly?: boolean;
  amenidades?: string[];
  tipo_evento?: string[];
  descripcion_corta?: string;
  foto_url?: string;
  owner_nombre?: string;
  descuento_max_pct?: number;
  especificacion_habitaciones?: string;
  observaciones_originales?: string;
  caracteristicas_originales?: string;
}

export interface PublicDetailItem extends PublicListItem {
  deposito_seguridad?: number;
  owner_contacto?: string;
  empleadas?: number;
  administrador_nombre?: string;
  administrador_contacto?: string;
  pricing_model?: string;
  review_notes?: string;
}

export interface MatchResult {
  error: boolean;
  operation: Operation;
  matched_count: number;
  items: PublicListItem[];
  similar_items: PublicListItem[];
  selected_finca: PublicDetailItem | null;
  owner: { finca_id: string; nombre: string; owner_nombre?: string; owner_contacto?: string } | null;
  search_applied: Record<string, unknown>;
  notes: string | null;
}

// ----- helpers ---------------------------------------------------------------

const compact = (v: unknown) => String(v ?? '').trim();

function toNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : fallback;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function tokenise(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function inferFincaIdsFromText(value: string): string[] {
  const matches = String(value || '').match(/[A-ZÁÉÍÓÚÑ]{3,}(?:_|\s)#\d+/g) ?? [];
  return Array.from(
    new Set(matches.map((item) => item.replace(/\s+#/g, '_#').replace(/\s+/g, '_').toUpperCase())),
  );
}

function calculateNights(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  return diff > 0 ? diff : null;
}

function nightlyReference(item: Finca, nights: number | null): number | null {
  if (item.precio_noche_base) return item.precio_noche_base;
  if (item.precio_fin_semana && nights) return Math.round(item.precio_fin_semana / Math.max(nights, 2));
  if (item.precio_fin_semana) return Math.round(item.precio_fin_semana / 2);
  return null;
}

function arrayFromCriteria(value: unknown): string[] {
  return parseJsonArray(value)
    .map((item) => compact(item))
    .filter(Boolean);
}

function sanitizeListItem(item: Finca, nights: number | null): PublicListItem {
  return {
    finca_id: item.fincaId,
    nombre: item.realName,
    codigo_original: item.codigo_original,
    zona: item.zona,
    municipio: item.ciudad,
    capacidad_max: item.capacidadMax,
    capacidad_minima_tarifa: item.capacidad_minima_tarifa,
    habitaciones: item.habitaciones,
    min_noches: item.min_noches,
    precio_noche_base: item.precio_noche_base ?? item.precioPorNoche,
    precio_fin_semana: item.precio_fin_semana,
    precio_festivo: item.precio_festivo,
    precio_semana_santa_receso: item.precio_semana_santa_receso,
    precio_temporada_alta: item.precio_temporada_alta,
    precio_persona_extra: item.precio_persona_extra,
    precio_referencia_noche: nightlyReference(item, nights),
    pet_friendly: item.mascotas,
    amenidades: item.amenidades,
    tipo_evento: item.tipo_evento,
    descripcion_corta: item.descripcionCorta,
    foto_url: item.foto_url ?? (item.fotos?.[0] ?? undefined),
    owner_nombre: item.owner_nombre,
    descuento_max_pct: item.descuento_max_pct,
    especificacion_habitaciones: item.especificacion_habitaciones,
    observaciones_originales: item.observaciones_originales,
    caracteristicas_originales: item.caracteristicas_originales,
  };
}

function sanitizeDetailItem(
  item: Finca,
  nights: number | null,
  ownerContactOverride: string,
): PublicDetailItem {
  return {
    ...sanitizeListItem(item, nights),
    deposito_seguridad: item.deposito_seguridad,
    owner_contacto: ownerContactOverride || item.owner_contacto,
    empleadas: item.empleadas,
    administrador_nombre: item.administrador_nombre,
    administrador_contacto: item.administrador_contacto,
    pricing_model: item.pricing_model,
    review_notes: item.review_notes,
  };
}

// ----- main entry point -----------------------------------------------------

export function matchInventory(input: MatchInput): MatchResult {
  const inventory = input.inventory;
  const ownerContactOverride = compact(input.owner_contact_override);
  const runtimeSearchCriteria = input.current_search_criteria ?? {};

  const opInput = normalizeText(input.operation);
  const operation: Operation = (() => {
    if (
      [
        'mostrar_propiedades',
        'show_properties',
        'buscar_fincas',
        'search_fincas',
        'list_matching_fincas',
        'list',
      ].includes(opInput)
    )
      return 'list_matching_fincas';
    if (
      [
        'pregunta_propiedad',
        'property_question',
        'finca_question',
        'detalle_finca',
        'get_finca_details',
        'details',
      ].includes(opInput)
    )
      return 'get_finca_details';
    if (['contacto_propietario', 'owner_contact', 'get_owner_contact'].includes(opInput))
      return 'get_owner_contact';
    return 'list_matching_fincas';
  })();

  const explicitFincaId = compact(input.finca_id ?? input.selected_finca_id);
  const explicitName = compact(input.nombre ?? input.selected_finca_nombre);
  const query = compact(input.query);
  const zona = compact(
    input.zona ??
      input.context_zona ??
      (typeof runtimeSearchCriteria.zona === 'string'
        ? runtimeSearchCriteria.zona
        : Array.isArray(runtimeSearchCriteria.zona) && runtimeSearchCriteria.zona.length > 0
          ? String(runtimeSearchCriteria.zona[0])
          : ''),
  );
  const personas = toNumber(input.personas ?? input.context_personas ?? runtimeSearchCriteria.personas);
  const presupuestoMax = toNumber(
    input.presupuesto_max ?? input.context_presupuesto_max ?? runtimeSearchCriteria.presupuestoMax,
  );
  const nights = calculateNights(
    input.context_fecha_inicio ?? (runtimeSearchCriteria.fechaInicio as string | undefined),
    input.context_fecha_fin ?? (runtimeSearchCriteria.fechaFin as string | undefined),
  );
  const defaultLimit = Math.max(1, Math.min(10, input.default_limit ?? 3));
  const limit = Math.max(1, Math.min(10, toNumber(input.limit, defaultLimit) ?? defaultLimit));

  const normalizedMessage = normalizeText(query);
  const messageRejectsCurrentSelection =
    /\b(no esa|esa no|no me gusto esa|no me gustó esa|no quiero esa|descarta esa)\b/.test(normalizedMessage);

  // Discover known zones / municipios from the inventory itself.
  const knownMunicipios = uniqueValues(inventory.map((item) => compact(item.ciudad)).filter(Boolean));
  const knownZonas = uniqueValues([
    ...inventory.map((item) => compact(item.zona)).filter(Boolean),
    ...['cerca a Bogotá', 'cerca a Medellín'],
  ]);

  // ---- accumulate exclusions from criteria + current message --------------
  const criteriaAmenidadesPositivas = uniqueValues(
    arrayFromCriteria(runtimeSearchCriteria.amenidades).map(
      (item) => resolveAmenityAlias(item) || item,
    ),
  );
  const criteriaAmenidadesExcluidasBase = uniqueValues(
    arrayFromCriteria((runtimeSearchCriteria as Record<string, unknown>).amenidades_excluidas).map(
      (item) => resolveAmenityAlias(item) || item,
    ),
  );
  const criteriaZonasExcluidasBase = uniqueValues(
    arrayFromCriteria((runtimeSearchCriteria as Record<string, unknown>).zonas_excluidas),
  );
  const criteriaMunicipiosExcluidosBase = uniqueValues(
    arrayFromCriteria((runtimeSearchCriteria as Record<string, unknown>).municipios_excluidos),
  );
  const criteriaFincasExcluidasBase = uniqueValues(
    arrayFromCriteria((runtimeSearchCriteria as Record<string, unknown>).fincas_excluidas),
  );

  const messageAmenidadesExcluidas = detectAmenityValuesFromMessage(query, negativePatternTemplates);
  const messageAmenidadesPermitidas = detectAmenityValuesFromMessage(query, clearPatternTemplates);
  const messageZonasExcluidas = detectZoneValuesFromMessage(query, knownZonas, negativePatternTemplates);
  const messageZonasPermitidas = detectZoneValuesFromMessage(query, knownZonas, clearPatternTemplates);
  const messageMunicipiosExcluidos = detectMunicipioValuesFromMessage(
    query,
    knownMunicipios,
    negativePatternTemplates,
  );
  const messageMunicipiosPermitidos = detectMunicipioValuesFromMessage(
    query,
    knownMunicipios,
    clearPatternTemplates,
  );

  const amenidadesExcluidas = uniqueValues([
    ...criteriaAmenidadesExcluidasBase.filter(
      (item) =>
        !messageAmenidadesPermitidas.some((allowed) => normalizeText(allowed) === normalizeText(item)),
    ),
    ...messageAmenidadesExcluidas,
  ]);
  const zonasExcluidas = uniqueValues([
    ...criteriaZonasExcluidasBase.filter(
      (item) => !messageZonasPermitidas.some((allowed) => normalizeText(allowed) === normalizeText(item)),
    ),
    ...messageZonasExcluidas,
  ]);
  const municipiosExcluidos = uniqueValues([
    ...criteriaMunicipiosExcluidosBase.filter(
      (item) =>
        !messageMunicipiosPermitidos.some((allowed) => normalizeText(allowed) === normalizeText(item)),
    ),
    ...messageMunicipiosExcluidos,
  ]);
  const fincasExcluidas = uniqueValues([
    ...criteriaFincasExcluidasBase,
    ...inferFincaIdsFromText([query, explicitFincaId, explicitName].filter(Boolean).join(' ')),
    ...(messageRejectsCurrentSelection && explicitFincaId ? [explicitFincaId] : []),
  ]);

  const shownFincas = new Set(
    [
      ...parseJsonArray(input.shown_fincas_json ?? '[]'),
      ...fincasExcluidas,
    ].map((item) => String(item)),
  );

  // ---- compute scoring inputs --------------------------------------------
  const negativeTokens = new Set(
    tokenise(
      [...amenidadesExcluidas, ...zonasExcluidas, ...municipiosExcluidos, ...fincasExcluidas].join(' '),
    ),
  );
  const positiveTokens = tokenise(
    [query, explicitName, explicitFincaId, zona, ...criteriaAmenidadesPositivas]
      .filter(Boolean)
      .join(' '),
  ).filter((token) => !negativeTokens.has(token));

  const resolvedZoneAlias = resolveZoneAlias(zona);
  const zoneTargets = resolvedZoneAlias
    ? resolvedZoneAlias.targets.map(normalizeText)
    : zona
      ? [normalizeText(zona)]
      : [];
  const excludedLocationTargets = uniqueValues(
    [...zonasExcluidas, ...municipiosExcluidos].flatMap((item) => resolveLocationExpressionTargets(item)),
  ).map(normalizeText);
  const preferredAmenityTargets = new Set(
    uniqueValues(criteriaAmenidadesPositivas.map((item) => resolveAmenityAlias(item) || item)).map(
      normalizeText,
    ),
  );
  const excludedAmenityTargets = new Set(
    uniqueValues(amenidadesExcluidas.map((item) => resolveAmenityAlias(item) || item)).map(normalizeText),
  );
  const excludedFincaTargets = new Set(fincasExcluidas.map(normalizeText));

  const locationMatchesTargets = (item: Finca, targets: string[]) => {
    if (!targets.length) return false;
    const itemZona = normalizeText(item.zona);
    const itemMunicipio = normalizeText(item.ciudad);
    return targets.some(
      (target) =>
        itemZona.includes(target) ||
        itemMunicipio.includes(target) ||
        target.includes(itemZona) ||
        target.includes(itemMunicipio),
    );
  };

  const zoneMatches = (item: Finca) => {
    if (!zoneTargets.length) return true;
    return locationMatchesTargets(item, zoneTargets);
  };

  const itemAmenityTargets = (item: Finca) =>
    new Set(
      uniqueValues(
        (Array.isArray(item.amenidades) ? item.amenidades : []).map(
          (entry) => resolveAmenityAlias(entry) || entry,
        ),
      ).map(normalizeText),
    );

  const matchesExcludedLocation = (item: Finca) =>
    excludedLocationTargets.length ? locationMatchesTargets(item, excludedLocationTargets) : false;
  const matchesExcludedFinca = (item: Finca) => {
    if (!excludedFincaTargets.size) return false;
    return (
      excludedFincaTargets.has(normalizeText(item.fincaId)) ||
      excludedFincaTargets.has(normalizeText(item.realName)) ||
      excludedFincaTargets.has(normalizeText(item.codigo_original))
    );
  };
  const itemHasExcludedAmenity = (item: Finca) => {
    if (!excludedAmenityTargets.size) return false;
    const amenityTargets = itemAmenityTargets(item);
    return Array.from(excludedAmenityTargets).some((target) => amenityTargets.has(target));
  };
  const countPreferredAmenities = (item: Finca) => {
    if (!preferredAmenityTargets.size) return 0;
    const amenityTargets = itemAmenityTargets(item);
    return Array.from(preferredAmenityTargets).filter((target) => amenityTargets.has(target)).length;
  };

  // ---- scoring ------------------------------------------------------------
  const scoreItem = (item: Finca, strict: boolean): number => {
    let score = 0;
    if (explicitFincaId && normalizeText(item.fincaId) === normalizeText(explicitFincaId)) score += 1000;
    if (explicitName && normalizeText(item.realName).includes(normalizeText(explicitName))) score += 280;
    if (zona) {
      if (zoneMatches(item)) score += strict ? 160 : 120;
      else score -= strict ? 600 : 120;
    }
    if (personas !== null && item.capacidadMax) {
      if (item.capacidadMax >= personas) {
        score += 90;
        score -= Math.max(0, item.capacidadMax - personas) * 0.5;
      } else {
        score -= strict ? 800 : 180;
      }
    }
    if (nights !== null && item.min_noches != null) {
      if (item.min_noches <= nights) score += 20;
      else score -= strict ? 120 : 40;
    }
    if (presupuestoMax !== null) {
      const refPrice = nightlyReference(item, nights);
      if (refPrice !== null) {
        const delta = Math.abs(refPrice - presupuestoMax);
        const deltaRatio = presupuestoMax > 0 ? delta / presupuestoMax : 0;
        score += Math.max(0, 90 - deltaRatio * 110);
        if (refPrice <= presupuestoMax) score += 25;
        else score -= Math.min(50, deltaRatio * 70);
      }
    }
    const preferredAmenityMatches = countPreferredAmenities(item);
    if (preferredAmenityMatches > 0) score += preferredAmenityMatches * 28;
    if (positiveTokens.length) {
      const haystack = normalizeText(
        [
          item.fincaId,
          item.realName,
          item.codigo_original,
          item.zona,
          item.ciudad,
          item.descripcionCorta,
          item.observaciones_originales,
          item.caracteristicas_originales,
          (item.amenidades ?? []).join(' '),
          (item.tipo_evento ?? []).join(' '),
        ]
          .filter(Boolean)
          .join(' '),
      );
      for (const token of positiveTokens) {
        if (haystack.includes(token)) score += 16;
      }
    }
    score -= Number(item.prioridad ?? 999) / 1000;
    return score;
  };

  const ranked = (items: Finca[], strict: boolean): Finca[] =>
    items
      .map((item) => ({ item, score: scoreItem(item, strict) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(a.item.prioridad ?? 999) - Number(b.item.prioridad ?? 999) ||
          String(a.item.realName).localeCompare(String(b.item.realName)),
      )
      .map(({ item }) => item);

  // ---- candidates ---------------------------------------------------------
  const strictCandidates = inventory.filter((item) => {
    if (!zoneMatches(item)) return false;
    if (personas !== null && item.capacidadMax && item.capacidadMax < personas) return false;
    if (matchesExcludedLocation(item)) return false;
    if (matchesExcludedFinca(item)) return false;
    if (itemHasExcludedAmenity(item)) return false;
    return true;
  });

  const similarCandidates = inventory.filter((item) => {
    if (shownFincas.has(String(item.fincaId))) return false;
    if (matchesExcludedLocation(item)) return false;
    if (matchesExcludedFinca(item)) return false;
    if (itemHasExcludedAmenity(item)) return false;
    if (zona && !zoneMatches(item) && personas !== null && item.capacidadMax && item.capacidadMax < personas) {
      return false;
    }
    return true;
  });

  const strictRanked = ranked(strictCandidates, true).filter(
    (item) => !shownFincas.has(String(item.fincaId)),
  );
  const similarRanked = ranked(similarCandidates, false).filter(
    (item) => !shownFincas.has(String(item.fincaId)),
  );

  const search_applied = {
    zona,
    personas,
    presupuesto_max: presupuestoMax,
    nights,
    amenidades_preferidas: criteriaAmenidadesPositivas,
    amenidades_excluidas: amenidadesExcluidas,
    zonas_excluidas: zonasExcluidas,
    municipios_excluidos: municipiosExcluidos,
    fincas_excluidas: fincasExcluidas,
    query,
    excluded_finca_ids: Array.from(shownFincas),
  };

  // ---- operation dispatch -------------------------------------------------
  if (operation === 'list_matching_fincas') {
    const exactItems = strictRanked.slice(0, limit).map((item) => sanitizeListItem(item, nights));
    const similarItems = (strictRanked.length ? strictRanked.slice(limit) : similarRanked)
      .slice(0, limit)
      .map((item) => sanitizeListItem(item, nights));

    return {
      error: false,
      operation,
      matched_count: exactItems.length,
      items: exactItems,
      similar_items: exactItems.length ? [] : similarItems,
      selected_finca: null,
      owner: null,
      search_applied,
      notes: exactItems.length
        ? null
        : similarItems.length
          ? 'no_exact_match_but_similar'
          : 'no_match',
    };
  }

  // For details / owner_contact, find the best match and return it
  const findBestMatch = (): Finca | null => {
    if (!inventory.length) return null;
    if (explicitFincaId) {
      const exact = inventory.find(
        (item) => normalizeText(item.fincaId) === normalizeText(explicitFincaId),
      );
      if (exact) return exact;
    }
    return ranked(inventory, false)[0] ?? null;
  };

  const bestMatch = findBestMatch();

  if (operation === 'get_owner_contact') {
    return {
      error: false,
      operation,
      matched_count: bestMatch ? 1 : 0,
      items: [],
      similar_items: [],
      selected_finca: bestMatch ? sanitizeDetailItem(bestMatch, nights, ownerContactOverride) : null,
      owner: bestMatch
        ? {
            finca_id: bestMatch.fincaId,
            nombre: bestMatch.realName,
            owner_nombre: bestMatch.owner_nombre,
            owner_contacto: ownerContactOverride || bestMatch.owner_contacto,
          }
        : null,
      search_applied: { finca_id: explicitFincaId, nombre: explicitName, query } as Record<string, unknown>,
      notes: bestMatch ? null : 'owner_contact_not_found',
    };
  }

  return {
    error: false,
    operation: 'get_finca_details',
    matched_count: bestMatch ? 1 : 0,
    items: [],
    similar_items: [],
    selected_finca: bestMatch ? sanitizeDetailItem(bestMatch, nights, ownerContactOverride) : null,
    owner: null,
    search_applied: { finca_id: explicitFincaId, nombre: explicitName, query } as Record<string, unknown>,
    notes: bestMatch ? null : 'finca_not_found',
  };
}

// Re-export amenity definitions for stage prompts that need them
export { amenityAliasDefinitions };
