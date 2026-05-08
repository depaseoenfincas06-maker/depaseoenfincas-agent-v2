import { describe, it, expect } from 'vitest';
import {
  daysBetweenIsoDates,
  textToPaymentMethods,
  encodeBase64UrlJson,
  decodeBase64UrlJson,
  signPdfPayload,
  verifyPdfPayload,
  buildReservationPdfUrl,
} from './reservation-pdf-url.js';
import type { Finca } from '../inventory/types.js';

describe('daysBetweenIsoDates', () => {
  it('counts whole days between two ISO dates', () => {
    expect(daysBetweenIsoDates('2026-05-15', '2026-05-18')).toBe(3);
  });
  it('returns 0 for same date', () => {
    expect(daysBetweenIsoDates('2026-05-15', '2026-05-15')).toBe(0);
  });
  it('returns 0 for malformed dates', () => {
    expect(daysBetweenIsoDates('xx', '2026-05-18')).toBe(0);
    expect(daysBetweenIsoDates('', '')).toBe(0);
  });
});

describe('textToPaymentMethods', () => {
  it('splits comma list and title-cases each', () => {
    expect(textToPaymentMethods('transferencia, efectivo, daviplata')).toEqual([
      'Transferencia',
      'Efectivo',
      'Daviplata',
    ]);
  });
  it('handles semicolons and newlines', () => {
    expect(textToPaymentMethods('nequi;\ntransferencia')).toEqual(['Nequi', 'Transferencia']);
  });
  it('returns [] for null/empty', () => {
    expect(textToPaymentMethods(null)).toEqual([]);
    expect(textToPaymentMethods('')).toEqual([]);
  });
});

describe('encodeBase64UrlJson / decodeBase64UrlJson', () => {
  it('round-trips arbitrary JSON', () => {
    const obj = { a: 1, b: 'hello', c: [1, 2, 3], d: { e: 'world' } };
    const enc = encodeBase64UrlJson(obj);
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect(enc).not.toContain('=');
    expect(decodeBase64UrlJson(enc)).toEqual(obj);
  });
  it('returns null for malformed input', () => {
    expect(decodeBase64UrlJson('not-base64')).toBeNull();
  });
});

describe('signPdfPayload + verifyPdfPayload', () => {
  it('verifies a correctly-signed payload', () => {
    const payload = encodeBase64UrlJson({ x: 1 });
    const sig = signPdfPayload(payload, 'shh');
    const r = verifyPdfPayload(payload, sig, 'shh');
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ x: 1 });
  });
  it('rejects when secret differs', () => {
    const payload = encodeBase64UrlJson({ x: 1 });
    const sig = signPdfPayload(payload, 'right');
    expect(verifyPdfPayload(payload, sig, 'wrong').ok).toBe(false);
  });
  it('rejects when sig is tampered', () => {
    const payload = encodeBase64UrlJson({ x: 1 });
    const sig = signPdfPayload(payload, 'shh');
    expect(verifyPdfPayload(payload, sig.slice(0, -1) + '0', 'shh').ok).toBe(false);
  });
  it('rejects empty inputs', () => {
    expect(verifyPdfPayload('', 'sig', 'shh').ok).toBe(false);
    expect(verifyPdfPayload('p', '', 'shh').ok).toBe(false);
    expect(verifyPdfPayload('p', 'sig', '').ok).toBe(false);
  });
});

describe('buildReservationPdfUrl', () => {
  const finca: Finca = {
    fincaId: 'F009',
    realName: 'Finca Real',
    codigo_original: 'PEREIRA #09',
    zona: 'Eje cafetero',
    capacidadMax: 10,
    amenidades: [],
    mascotas: false,
    fotos: [],
    raw: {},
    precio_noche_base: 1_200_000,
    deposito_seguridad: 500_000,
  };

  it('builds a signed URL with reservation totals', () => {
    const { url, payload } = buildReservationPdfUrl({
      finca,
      reservation: {
        nombreCompleto: 'Juan Pérez',
        tipoDocumento: 'CC',
        numeroDocumento: '1234567',
        celular: '3001234567',
        email: 'jp@example.com',
        direccion: 'Cra 1 # 1-1',
      },
      searchCriteria: { fechaInicio: '2026-05-15', fechaFin: '2026-05-18', personas: 6 },
      paymentMethodsText: 'transferencia, efectivo',
      publicAppBaseUrl: 'https://dash.example.com',
      hmacSecret: 'shh',
    });

    expect(url).toContain('https://dash.example.com/api/reservation-confirmation.pdf');
    expect(url).toContain('payload=');
    expect(url).toContain('&sig=');
    expect(payload.noches).toBe(3);
    expect(payload.subtotal).toBe(3_600_000);
    expect(payload.total).toBe(4_100_000);
    expect(payload.anticipoRequerido).toBe(2_050_000); // 50% of total
    expect(payload.fincaCodigo).toBe('PEREIRA #09');
    expect(payload.metodoPago).toEqual(['Transferencia', 'Efectivo']);
    expect(payload.cliente.documento).toBe('CC 1234567');
  });

  it('builds a verifiable signed URL — round trip', () => {
    const { url } = buildReservationPdfUrl({
      finca,
      reservation: {},
      searchCriteria: { fechaInicio: '2026-05-15', fechaFin: '2026-05-16' },
      publicAppBaseUrl: 'https://dash.example.com',
      hmacSecret: 'shh',
    });
    const params = new URL(url).searchParams;
    const verifyResult = verifyPdfPayload(params.get('payload')!, params.get('sig')!, 'shh');
    expect(verifyResult.ok).toBe(true);
  });
});
