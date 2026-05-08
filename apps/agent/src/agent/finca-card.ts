/**
 * Finca card builder — direct port of v1's `buildFincaCard` /
 * `buildHighlightLines` / `buildTarifaLine` / `buildMediaMessages` /
 * `amenityLabel` from `Code in JavaScript1`.
 *
 * Produces the same WhatsApp-formatted text card v1 sends:
 *
 *   ☀️🌴*PEREIRA #09*🌴☀️
 *
 *   - 4 habitaciones 🍃
 *   - 3 baños 🚻
 *   - Piscina 🏊
 *   - Jacuzzi 🛁
 *   - BBQ ♨️
 *   - Capacidad máxima 10 personas 👥
 *   - Ubicada en Pereira, Eje cafetero
 *   Tiempo aproximado en vehículo: 1h
 *   Tarifa: $1.200.000/noche
 *
 * Followed by a media message containing all the photo URLs (Chatwoot can
 * carry an array of attachments per message). The agent emits these as a
 * sequence: card_text, media_with_photos, next_card_text, next_media, ...
 *
 * Privacy: we use `codigo_original` (PEREIRA #09) as the title — never the
 * real finca name. The OFFERING stage prompt enforces this server-side too.
 */

export interface FincaForCard {
  finca_id?: string;
  fincaId?: string;
  nombre?: string;
  realName?: string;
  codigo_original?: string;
  zona?: string;
  municipio?: string;
  ciudad?: string;
  habitaciones?: number;
  capacidad_max?: number;
  capacidadMax?: number;
  amenidades?: string[];
  descripcion_corta?: string;
  descripcionCorta?: string;
  observaciones_originales?: string;
  caracteristicas_originales?: string;
  especificacion_habitaciones?: string;
  precio_noche_base?: number;
  precio_fin_semana?: number;
  precio_referencia_noche?: number;
  precioPorNoche?: number;
  foto_url?: string;
  fotos?: string[];
  tiempo_en_vehiculo?: string;
  acomodacion_por_habitacion?: string;
  servicios_adicionales_texto?: string;
  limpieza_final_valor?: number;
  servicio_empleada_valor_8h?: number;
}

export interface OutboundItem {
  type: 'text' | 'media_group';
  content: string;
  media_url?: string | null;
  media_urls?: string[];
  property_title?: string | null;
  property_id?: string | null;
  media_count?: number;
}

const compact = (v: unknown) => String(v ?? '').trim();

function slugify(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleCase(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Pull all https URLs out of a string (foto_url often contains commas). */
function parseUrls(value: unknown): string[] {
  const matches = String(value ?? '').match(/https?:\/\/[^\s,]+/g) ?? [];
  return Array.from(new Set(matches));
}

function formatCurrency(value: unknown): string | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount);
}

function numberFromText(value: unknown, pattern: RegExp): number | null {
  const match = String(value ?? '').match(pattern);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueLines(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = slugify(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(String(value).trim());
  }
  return out;
}

/**
 * Map a raw amenity string to a display label with emoji. Direct port from
 * v1; the patterns + emoji choices match what the team curated for the
 * customer-facing cards.
 */
function amenityLabel(rawValue: string): string | null {
  const value = slugify(rawValue);
  const map: { pattern: RegExp; label: string }[] = [
    { pattern: /piscina/, label: 'Piscina 🏊' },
    { pattern: /jacuzzi/, label: 'Jacuzzi 🛁' },
    { pattern: /kiosko|quiosco/, label: 'Kiosko 🔝' },
    { pattern: /tejo/, label: 'Cancha de tejo 🎯' },
    { pattern: /micro futbol|microfutbol|futbol/, label: 'Cancha de micro fútbol ⚽️' },
    { pattern: /ping pong/, label: 'Mesa de ping pong 🏓' },
    { pattern: /billar|pool|mini mesa de billar/, label: 'Mesa de billar 🎱' },
    { pattern: /rana/, label: 'Rana 🐸' },
    { pattern: /bbq/, label: 'BBQ ♨️' },
    { pattern: /zonas verdes|zona verde/, label: 'Zonas verdes 🌴' },
    { pattern: /wifi|wi fi/, label: 'Wifi 🛜' },
    { pattern: /golf/, label: 'Golf ⛳️' },
    { pattern: /tenis/, label: 'Tenis 🎾' },
    { pattern: /parqueadero/, label: 'Parqueadero 🚗' },
    { pattern: /pet friendly|mascotas/, label: 'Pet friendly 🐶' },
    { pattern: /empleada/, label: 'Servicio de empleada 👩‍🍳' },
  ];

  const matched = map.find((item) => item.pattern.test(value));
  if (matched) return matched.label;
  if (!value) return null;
  return titleCase(rawValue);
}

function buildHighlightLines(finca: FincaForCard): string[] {
  const combinedText = [
    finca.descripcion_corta ?? finca.descripcionCorta,
    finca.observaciones_originales,
    finca.caracteristicas_originales,
    finca.especificacion_habitaciones,
  ]
    .filter(Boolean)
    .join('\n');

  const lines: string[] = [];

  // Habitaciones
  if (finca.habitaciones) {
    lines.push(`${finca.habitaciones} habitaciones 🍃`);
  } else {
    const habitaciones = numberFromText(combinedText, /(\d+)\s+habitaciones?/i);
    if (habitaciones) lines.push(`${habitaciones} habitaciones 🍃`);
  }

  // Baños — extracted from text only (no dedicated column)
  const banos = numberFromText(combinedText, /(\d+)\s+bañ?os?/i);
  if (banos) lines.push(`${banos} baños 🚻`);

  // Amenities (with emoji labels)
  const amenidades = Array.isArray(finca.amenidades) ? finca.amenidades : [];
  for (const amenidad of amenidades) {
    const label = amenityLabel(amenidad);
    if (label) lines.push(label);
  }

  // Capacidad máxima
  const capacidadMax = finca.capacidad_max ?? finca.capacidadMax;
  if (capacidadMax) {
    lines.push(`Capacidad máxima ${capacidadMax} personas 👥`);
  }

  // Ubicación
  const municipio = finca.municipio ?? finca.ciudad;
  if (municipio || finca.zona) {
    const locationLabel =
      municipio && finca.zona && slugify(municipio) !== slugify(finca.zona)
        ? `Ubicada en ${municipio}, ${finca.zona}`
        : `Ubicada en ${municipio ?? finca.zona}`;
    lines.push(locationLabel);
  }

  return uniqueLines(lines);
}

function buildTarifaLine(finca: FincaForCard): string | null {
  if (finca.precio_noche_base) {
    return `Tarifa: ${formatCurrency(finca.precio_noche_base)}/noche`;
  }
  if (finca.precio_fin_semana) {
    return `Tarifa: ${formatCurrency(finca.precio_fin_semana)}/fin de semana`;
  }
  if (finca.precio_referencia_noche) {
    return `Tarifa: ${formatCurrency(finca.precio_referencia_noche)}/noche`;
  }
  if (finca.precioPorNoche) {
    return `Tarifa: ${formatCurrency(finca.precioPorNoche)}/noche`;
  }
  return null;
}

/**
 * Build the formatted text card for a single finca (v1 styling exactly).
 * Title uses `codigo_original` (e.g. "PEREIRA #09") to enforce the privacy
 * invariant — never the real finca name in OFFERING.
 */
export function buildFincaCard(finca: FincaForCard): string | null {
  if (!finca || typeof finca !== 'object') return null;
  const fincaId = finca.finca_id ?? finca.fincaId ?? '';
  const title = compact(finca.codigo_original ?? fincaId ?? 'Finca');
  const code = compact(finca.codigo_original ?? fincaId ?? '');
  const highlights = buildHighlightLines(finca);
  const tarifa = buildTarifaLine(finca);
  const parts: (string | null)[] = [
    `☀️🌴*${title}*🌴☀️`,
    code && code !== title ? code : null,
    null,
    ...highlights.map((line) => `- ${line}`),
    finca.tiempo_en_vehiculo ? `Tiempo aproximado en vehículo: ${finca.tiempo_en_vehiculo}` : null,
    finca.acomodacion_por_habitacion
      ? `Acomodación por habitación: ${finca.acomodacion_por_habitacion}`
      : null,
    Number.isFinite(Number(finca.limpieza_final_valor)) && Number(finca.limpieza_final_valor) > 0
      ? `Limpieza final: ${formatCurrency(finca.limpieza_final_valor)}`
      : null,
    Number.isFinite(Number(finca.servicio_empleada_valor_8h)) && Number(finca.servicio_empleada_valor_8h) > 0
      ? `Servicio de empleada (8h): ${formatCurrency(finca.servicio_empleada_valor_8h)}`
      : null,
    finca.servicios_adicionales_texto
      ? `Servicios adicionales: ${finca.servicios_adicionales_texto}`
      : null,
    tarifa,
  ];
  return parts
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .join('\n');
}

/** Build the media-group message that follows the card with the photos. */
export function buildMediaMessages(finca: FincaForCard): OutboundItem[] {
  const urls = finca.fotos && finca.fotos.length ? finca.fotos : parseUrls(finca.foto_url);
  if (!urls.length) return [];
  const fincaId = finca.finca_id ?? finca.fincaId ?? '';
  const title = finca.codigo_original ?? fincaId ?? 'la finca';
  return [
    {
      type: 'media_group',
      content: '',
      media_url: urls[0],
      media_urls: urls,
      property_title: title,
      property_id: fincaId || null,
      media_count: urls.length,
    },
  ];
}

/**
 * Build the full outbound sequence for showing fincas:
 * [card_1, media_1, card_2, media_2, ...]
 * Emit a text item only if the card was built; emit media only if photos
 * exist.
 */
export function buildPropertySequence(fincas: FincaForCard[]): OutboundItem[] {
  const out: OutboundItem[] = [];
  for (const finca of fincas) {
    const card = buildFincaCard(finca);
    if (card) {
      out.push({
        type: 'text',
        content: card,
        property_title: finca.codigo_original ?? finca.finca_id ?? finca.fincaId ?? null,
        property_id: finca.finca_id ?? finca.fincaId ?? null,
      });
    }
    out.push(...buildMediaMessages(finca));
  }
  return out;
}
