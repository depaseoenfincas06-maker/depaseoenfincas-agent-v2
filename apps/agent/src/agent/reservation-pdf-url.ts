/**
 * Reservation PDF link builder — direct port of v1's
 * `createReservationDocumentItem` + `encodeBase64UrlJson` +
 * `daysBetweenIsoDates` + `textToPaymentMethods` from `Code in JavaScript1`.
 *
 * Why a public URL: WhatsApp can deliver the reservation PDF as a document
 * attachment, but Meta requires a public HTTP(S) URL. We can't host the PDF
 * directly because the data is per-conversation and ephemeral. So instead
 * we encode the FULL payload into a base64url-encoded URL parameter,
 * sign it with HMAC, and the dashboard renders the PDF on demand from the
 * payload at request time.
 *
 * Security: HMAC-SHA256(secret, payload_b64url) is appended as `&sig=`.
 * The dashboard verifies sig before rendering. Without this anyone could
 * forge a confirmation PDF for any reservation. Constant-time compare.
 */
import { createHmac } from 'node:crypto';
import type { Finca } from '../inventory/types.js';

export interface ReservationPdfPayload {
  /** Customer-facing display name. */
  fincaCodigo: string;
  fincaRealName: string;
  fechaInicio: string;
  fechaFin: string;
  noches: number;
  personas: number;
  precioPorNoche: number;
  subtotal: number;
  depositoSeguridad: number;
  total: number;
  anticipoRequerido: number;
  metodoPago: string[];
  cliente: {
    nombre: string;
    documento: string;
    celular: string;
    email: string;
    direccion: string;
  };
  emittedAt: string;
  /** Random nonce so two identical reservations get distinct URLs. */
  nonce: string;
}

/** ISO yyyy-mm-dd → days between (inclusive of start, exclusive of end). */
export function daysBetweenIsoDates(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(diff, 0);
}

/** "transferencia, efectivo, daviplata" → ["Transferencia","Efectivo","Daviplata"] */
export function textToPaymentMethods(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

/** base64url, no padding. */
export function encodeBase64UrlJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeBase64UrlJson<T = unknown>(s: string): T | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + padding, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function signPdfPayload(payloadB64Url: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64Url).digest('hex');
}

export interface BuildPdfUrlInput {
  finca: Finca;
  reservation: {
    nombreCompleto?: string;
    tipoDocumento?: string;
    numeroDocumento?: string;
    celular?: string;
    email?: string;
    direccion?: string;
  };
  searchCriteria: {
    fechaInicio?: string;
    fechaFin?: string;
    personas?: number;
  };
  paymentMethodsText?: string | null;
  publicAppBaseUrl: string;
  hmacSecret: string;
  /** Default 30 % of total. v1 hardcoded 50 %; kept configurable for now. */
  anticipoPercent?: number;
}

export function buildReservationPdfUrl(input: BuildPdfUrlInput): {
  url: string;
  payload: ReservationPdfPayload;
} {
  const { finca, reservation, searchCriteria, publicAppBaseUrl, hmacSecret } = input;
  const fechaInicio = searchCriteria.fechaInicio ?? '';
  const fechaFin = searchCriteria.fechaFin ?? '';
  const noches = daysBetweenIsoDates(fechaInicio, fechaFin) || 1;
  const personas = searchCriteria.personas ?? 0;
  const precioPorNoche =
    finca.precio_noche_base ?? finca.precioPorNoche ?? finca.precio_fin_semana ?? 0;
  const subtotal = precioPorNoche * noches;
  const depositoSeguridad = finca.deposito_seguridad ?? 0;
  const total = subtotal + depositoSeguridad;
  const anticipoPct = input.anticipoPercent ?? 0.5;
  const anticipoRequerido = Math.round(total * anticipoPct);

  const tipoDoc =
    (reservation.tipoDocumento ?? '').toUpperCase() || 'CC';
  const documento = reservation.numeroDocumento
    ? `${tipoDoc} ${reservation.numeroDocumento}`
    : '';

  const payload: ReservationPdfPayload = {
    fincaCodigo: finca.codigo_original ?? finca.fincaId,
    fincaRealName: finca.realName,
    fechaInicio,
    fechaFin,
    noches,
    personas,
    precioPorNoche,
    subtotal,
    depositoSeguridad,
    total,
    anticipoRequerido,
    metodoPago: textToPaymentMethods(input.paymentMethodsText),
    cliente: {
      nombre: reservation.nombreCompleto ?? '',
      documento,
      celular: reservation.celular ?? '',
      email: reservation.email ?? '',
      direccion: reservation.direccion ?? '',
    },
    emittedAt: new Date().toISOString(),
    nonce: Math.random().toString(36).slice(2, 10),
  };

  const b64 = encodeBase64UrlJson(payload);
  const sig = signPdfPayload(b64, hmacSecret);
  const base = publicAppBaseUrl.replace(/\/$/, '');
  const url = `${base}/api/reservation-confirmation.pdf?payload=${b64}&sig=${sig}`;
  return { url, payload };
}

export function verifyPdfPayload(
  payloadB64: string,
  sig: string,
  secret: string,
): { ok: boolean; payload?: ReservationPdfPayload } {
  if (!payloadB64 || !sig || !secret) return { ok: false };
  const expected = signPdfPayload(payloadB64, secret);
  if (expected.length !== sig.length) return { ok: false };
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (diff !== 0) return { ok: false };
  const payload = decodeBase64UrlJson<ReservationPdfPayload>(payloadB64);
  if (!payload) return { ok: false };
  return { ok: true, payload };
}
