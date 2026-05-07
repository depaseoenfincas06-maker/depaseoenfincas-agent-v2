/**
 * Inventory loader. Reads the Google Sheet (CSV export) and parses into
 * Finca[]. Cached in-memory for 5 minutes; can be force-refreshed via
 * refresh(). Designed for the orchestrator to call match() many times per
 * minute without hitting Google.
 *
 * If the sheet is unavailable or the document_id is not configured, we serve
 * the last-good cache (or empty array). NEVER throw from here — the caller
 * needs to be able to gracefully degrade.
 */
import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import type { Finca, FincaMatch, FincaQuery, PublicFincaView } from './types.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheState {
  fincas: Finca[];
  loadedAt: number;
}

let cache: CacheState | null = null;
let inFlight: Promise<Finca[]> | null = null;

function csvLineToFields(line: string): string[] {
  // CSV parser tolerant of quoted fields with commas. Good enough for Sheets.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return ['si', 'sí', 'yes', 'true', '1', 'permitidas', 'permitido'].includes(v);
}

function rowToFinca(headers: string[], cells: string[]): Finca | null {
  const get = (key: string) => {
    const idx = headers.findIndex((h) => h.toLowerCase().trim() === key.toLowerCase());
    return idx >= 0 ? cells[idx]?.trim() ?? '' : '';
  };
  const fincaId = get('finca_id') || get('id') || get('codigo');
  if (!fincaId) return null;
  const realName = get('nombre') || get('nombre_finca') || fincaId;
  const raw: Record<string, unknown> = {};
  headers.forEach((h, i) => {
    raw[h] = cells[i] ?? '';
  });
  return {
    fincaId,
    realName,
    zona: get('zona') || get('region') || '',
    ciudad: get('ciudad') || get('municipio') || undefined,
    capacidadMin: parseNumber(get('capacidad_min')),
    capacidadMax: parseNumber(get('capacidad_max')) ?? parseNumber(get('capacidad')) ?? 0,
    precioPorNoche: parseNumber(get('precio_por_noche')) ?? parseNumber(get('precio_noche')),
    precioPorPersona: parseNumber(get('precio_por_persona')),
    amenidades: parseList(get('amenidades')),
    mascotas: parseBool(get('mascotas')),
    fotos: parseList(get('fotos')) ?? parseList(get('imagenes')),
    descripcionCorta: get('descripcion') || get('descripcion_corta') || undefined,
    raw,
  };
}

async function fetchSheet(): Promise<Finca[]> {
  if (!config.INVENTORY_SHEET_DOCUMENT_ID) {
    logger.warn('INVENTORY_SHEET_DOCUMENT_ID not set — inventory empty');
    return [];
  }
  const tab = encodeURIComponent(config.INVENTORY_SHEET_TAB_NAME);
  const url = `https://docs.google.com/spreadsheets/d/${config.INVENTORY_SHEET_DOCUMENT_ID}/gviz/tq?tqx=out:csv&sheet=${tab}`;
  try {
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200) {
      logger.error({ statusCode: res.statusCode }, 'inventory fetch failed');
      return cache?.fincas ?? [];
    }
    const text = await res.body.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = csvLineToFields(lines[0]!);
    const fincas: Finca[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const finca = rowToFinca(headers, csvLineToFields(lines[i]!));
      if (finca) fincas.push(finca);
    }
    return fincas;
  } catch (err) {
    logger.error({ err }, 'inventory fetch threw');
    return cache?.fincas ?? [];
  }
}

export async function loadFincas(forceRefresh = false): Promise<Finca[]> {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.fincas;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const fincas = await fetchSheet();
    cache = { fincas, loadedAt: Date.now() };
    return fincas;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function refreshInventory(): Promise<number> {
  const fincas = await loadFincas(true);
  return fincas.length;
}

export function toPublicView(finca: Finca): PublicFincaView {
  return {
    fincaId: finca.fincaId,
    zona: finca.zona,
    ciudad: finca.ciudad,
    capacidadMax: finca.capacidadMax,
    capacidadMin: finca.capacidadMin,
    precioPorNoche: finca.precioPorNoche,
    precioPorPersona: finca.precioPorPersona,
    amenidades: finca.amenidades,
    mascotas: finca.mascotas,
    descripcionCorta: finca.descripcionCorta,
  };
}

function asArray(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function score(finca: Finca, q: FincaQuery): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];
  let s = 100;

  // Hard filters (return null = exclude)
  if (q.personas && finca.capacidadMax < q.personas) return null;
  if (q.personas && finca.capacidadMin && q.personas < finca.capacidadMin) {
    // Allow it but penalize, since group is smaller than min advertised.
    s -= 10;
    reasons.push(`capacidad mínima ${finca.capacidadMin} > grupo ${q.personas}`);
  }
  if (q.mascotas && !finca.mascotas) return null;
  // Zona / ciudad: OR matching. If the client said "Carmen O Girardot",
  // match if the finca's zona matches ANY of those. The penalty applies
  // only when NONE of the requested zones matched.
  const zonas = asArray(q.zona);
  if (zonas.length > 0 && finca.zona) {
    const anyMatch = zonas.some((z) => zonaMatches(finca.zona, z));
    if (!anyMatch) {
      s -= 30;
      reasons.push(`zona pedida "${zonas.join(' o ')}" vs zona finca "${finca.zona}"`);
    } else if (zonas.length > 1) {
      reasons.push(`matchea una de ${zonas.length} zonas pedidas`);
    }
  }
  const ciudades = asArray(q.ciudad);
  if (ciudades.length > 0 && finca.ciudad) {
    const anyMatch = ciudades.some((c) => zonaMatches(finca.ciudad ?? '', c));
    if (!anyMatch) {
      s -= 15;
      reasons.push(`ciudad pedida "${ciudades.join(' o ')}" vs ciudad finca "${finca.ciudad}"`);
    }
  }
  if (q.presupuestoMax && finca.precioPorNoche && finca.precioPorNoche > q.presupuestoMax) {
    s -= 25;
    reasons.push(`precio ${finca.precioPorNoche} > presupuesto ${q.presupuestoMax}`);
  }
  if (q.amenidadesRequeridas?.length) {
    const lower = finca.amenidades.map((a) => a.toLowerCase());
    const missing = q.amenidadesRequeridas.filter((a) => !lower.includes(a.toLowerCase()));
    if (missing.length) {
      s -= missing.length * 5;
      reasons.push(`amenidades faltantes: ${missing.join(', ')}`);
    }
  }
  // Capacity tightness bonus: prefer fincas where capacidad ≈ personas
  if (q.personas) {
    const slack = finca.capacidadMax - q.personas;
    if (slack >= 0 && slack <= 2) s += 10;
    else if (slack > 2) s -= slack;
  }
  return { score: s, reasons };
}

function zonaMatches(have: string, want: string): boolean {
  const a = have.toLowerCase().trim();
  const b = want.toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

export async function matchFincas(query: FincaQuery): Promise<FincaMatch[]> {
  const fincas = await loadFincas();
  const exclude = new Set((query.excludeIds ?? []).map((s) => s.toLowerCase()));
  const candidates: FincaMatch[] = [];
  for (const finca of fincas) {
    if (exclude.has(finca.fincaId.toLowerCase())) continue;
    const result = score(finca, query);
    if (!result) continue;
    candidates.push({
      finca,
      score: result.score,
      reasons: result.reasons,
      publicView: toPublicView(finca),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, query.limit ?? 5);
}

export async function getFincaById(fincaId: string): Promise<Finca | null> {
  const fincas = await loadFincas();
  const lower = fincaId.toLowerCase();
  return fincas.find((f) => f.fincaId.toLowerCase() === lower) ?? null;
}

/**
 * Test-only hook: pre-populates the in-memory cache so unit tests can run
 * matchFincas() against deterministic fixtures without hitting the network.
 * NOT exported via index — only accessible by direct import for tests.
 */
export function __test_setCache(fincas: Finca[]): void {
  cache = { fincas, loadedAt: Date.now() };
}
