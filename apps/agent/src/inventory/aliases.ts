/**
 * Zone + amenity alias tables. Direct port of the n8n `Build Inventory Tool
 * Response` node so v2 matches v1 exactly. When the client says "cerca a
 * Bogotá" we expand to a cluster of municipios; when they say "jacuzzi" we
 * also catch "hidromasaje". Without this table the matching is brittle and
 * misses obvious requests.
 */

export interface ZoneAlias {
  /** What the client typed (lowercased, accents removed for matching). */
  keys: string[];
  /** What we display back to the client. */
  label: string;
  /** Municipios in the cluster the client really wants. */
  targets: string[];
}

export const zoneAliasDefinitions: ZoneAlias[] = [
  {
    keys: [
      'cerca a bogota',
      'cerca de bogota',
      'bogota y alrededores',
      'bogota',
      'alrededores de bogota',
    ],
    label: 'cerca a Bogotá',
    targets: [
      'anapoima',
      'villeta',
      'la vega',
      'girardot',
      'carmen de apicala',
      'la mesa',
      'mesitas del colegio',
      'ricaurte',
      'melgar',
    ],
  },
  {
    keys: [
      'cerca a medellin',
      'cerca de medellin',
      'medellin o cerca',
      'medellin',
      'alrededores de medellin',
    ],
    label: 'cerca a Medellín',
    targets: [
      'antioquia',
      'santa fe de antioquia',
      'santafe de antioquia',
      'guatape',
      'el penol',
      'san jeronimo',
      'sopetran',
      'barbosa',
      'rionegro',
    ],
  },
];

export interface AmenityAlias {
  /** Canonical name to write back to search_criteria. */
  canonical: string;
  /** All ways the client might refer to it. */
  aliases: string[];
}

export const amenityAliasDefinitions: AmenityAlias[] = [
  { canonical: 'jacuzzi', aliases: ['jacuzzi', 'jacusi', 'hidromasaje'] },
  { canonical: 'piscina', aliases: ['piscina', 'pool'] },
  { canonical: 'bbq', aliases: ['bbq', 'barbecue', 'asador'] },
  { canonical: 'wifi', aliases: ['wifi', 'wi fi', 'internet'] },
  { canonical: 'parqueadero', aliases: ['parqueadero', 'garaje', 'parking'] },
  { canonical: 'kiosko', aliases: ['kiosko', 'quiosco'] },
  { canonical: 'cancha de tejo', aliases: ['tejo', 'cancha de tejo'] },
  {
    canonical: 'cancha de micro futbol',
    aliases: ['micro futbol', 'microfutbol', 'cancha de futbol', 'futbol'],
  },
  { canonical: 'mesa de ping pong', aliases: ['ping pong', 'mesa de ping pong'] },
  { canonical: 'mesa de billar', aliases: ['billar', 'mesa de billar', 'pool'] },
  { canonical: 'rana', aliases: ['rana'] },
  { canonical: 'zonas verdes', aliases: ['zonas verdes', 'zona verde'] },
  { canonical: 'pet friendly', aliases: ['pet friendly', 'mascotas', 'mascota'] },
  { canonical: 'servicio de empleada', aliases: ['empleada', 'servicio de empleada'] },
  { canonical: 'golf', aliases: ['golf'] },
  { canonical: 'tenis', aliases: ['tenis', 'cancha de tenis'] },
];

/**
 * Regex templates that detect when the client is excluding an amenity / zone
 * (e.g. "sin jacuzzi", "pero no Anapoima", "menos Guatapé"). The {alias}
 * placeholder gets substituted with the amenity name (already escaped + with
 * \\s+ for spaces).
 */
export const negativePatternTemplates = [
  (alias: string) => `(?:^|\\b)(?:sin|pero\\s+sin)\\s+${alias}(?:\\b|$)`,
  (alias: string) =>
    `(?:^|\\b)(?:pero\\s+no|menos|excepto|salvo|no\\s+sea|que\\s+no\\s+sea)\\s+${alias}(?:\\b|$)`,
  (alias: string) =>
    `(?:^|\\b)(?:no\\s+quiero(?:\\s+que\\s+tenga)?|que\\s+no\\s+tenga|que\\s+no\\s+sea)\\s+${alias}(?:\\b|$)`,
];

/**
 * Regex templates that detect the OPPOSITE — the client lifting a previous
 * restriction (e.g. "ya no importa el jacuzzi", "Anapoima sí puede ser",
 * "también puede ser piscina"). These clear the matching exclusion.
 */
export const clearPatternTemplates = [
  (alias: string) =>
    `(?:^|\\b)(?:ya\\s+no\\s+importa(?:\\s+si\\s+tiene)?|puede\\s+tener|tambien\\s+puede\\s+tener)\\s+${alias}(?:\\b|$)`,
  (alias: string) => `(?:^|\\b)${alias}\\s+(?:si|sí)\\s+puede\\s+ser(?:\\b|$)`,
  (alias: string) => `(?:^|\\b)tambien\\s+puede\\s+ser\\s+${alias}(?:\\b|$)`,
  (alias: string) => `(?:^|\\b)${alias}\\s+ya\\s+no\\s+importa(?:\\b|$)`,
];

/**
 * Strip accents and lowercase. Used everywhere the matching needs to be
 * tolerant of "jacuzzi" vs "jacusí" vs "Jacuzzi".
 */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Escape regex specials, then convert spaces to `\s+` for fuzzy matching. */
export function patterniseAlias(value: string): string {
  return normalizeText(value)
    .replace(/[|\\{}()[\]^$+*?.\-]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

export function resolveZoneAlias(value: string | null | undefined): ZoneAlias | null {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return null;
  return (
    zoneAliasDefinitions.find((alias) =>
      alias.keys.some((key) => normalizedValue.includes(key) || key.includes(normalizedValue)),
    ) ?? null
  );
}

/** Map a raw amenity string to its canonical form (or return as-is if no alias). */
export function resolveAmenityAlias(value: string | null | undefined): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return '';
  const alias = amenityAliasDefinitions.find((entry) =>
    entry.aliases.some((candidate) => normalizedValue.includes(normalizeText(candidate))),
  );
  return alias ? alias.canonical : String(value ?? '').trim();
}

/**
 * For a zone the client mentioned, return the list of normalized targets to
 * filter the inventory against. If the zone is an alias, returns the cluster;
 * otherwise returns just the normalized zone itself.
 */
export function resolveLocationExpressionTargets(value: string | null | undefined): string[] {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return [];
  const alias = resolveZoneAlias(value);
  return alias ? alias.targets.map(normalizeText) : [normalizedValue];
}

/**
 * Test whether a message matches any of the regex templates for the given
 * aliases. Used for both "negate" and "clear" detection.
 */
export function messageMatchesPatterns(
  message: string,
  aliases: string[],
  templates: ((alias: string) => string)[],
): boolean {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return false;
  return aliases.some((alias) => {
    const patternAlias = patterniseAlias(alias);
    return templates.some((template) => new RegExp(template(patternAlias), 'i').test(normalizedMessage));
  });
}

/**
 * Apply the alias map (any of negative or clear) to a list of definitions and
 * return the canonical names that match.
 */
export function detectAmenityValuesFromMessage(
  message: string,
  templates: ((alias: string) => string)[],
): string[] {
  return uniqueValues(
    amenityAliasDefinitions
      .filter((definition) => messageMatchesPatterns(message, definition.aliases, templates))
      .map((definition) => definition.canonical),
  );
}

/**
 * Same shape as `detectAmenityValuesFromMessage` but for known zones — the
 * caller passes the zones discovered from inventory (so we only flag zones
 * we actually recognize).
 */
export function detectZoneValuesFromMessage(
  message: string,
  knownZones: string[],
  templates: ((alias: string) => string)[],
): string[] {
  return uniqueValues(
    knownZones.filter((candidate) =>
      messageMatchesPatterns(
        message,
        [candidate, ...(resolveZoneAlias(candidate)?.keys ?? [])],
        templates,
      ),
    ),
  );
}

export function detectMunicipioValuesFromMessage(
  message: string,
  knownMunicipios: string[],
  templates: ((alias: string) => string)[],
): string[] {
  return uniqueValues(
    knownMunicipios.filter((candidate) =>
      messageMatchesPatterns(message, [candidate], templates),
    ),
  );
}

export function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    const normalized = normalizeText(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.set(normalized, trimmed);
  }
  return Array.from(seen.values());
}
