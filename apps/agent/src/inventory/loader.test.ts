/**
 * Unit tests for inventory matching. We seed the cache via reflection so we
 * don't need a live Google Sheet — the matchFincas() logic is what we want
 * to lock in, especially the multi-zone OR feature.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { matchFincas } from './loader.js';
import type { Finca } from './types.js';

const FIXTURE: Finca[] = [
  {
    fincaId: 'F001',
    realName: 'Casa del Lago',
    zona: 'Carmen de Apicalá',
    ciudad: 'Carmen de Apicalá',
    capacidadMin: 4,
    capacidadMax: 8,
    precioPorNoche: 800000,
    amenidades: ['piscina', 'BBQ'],
    mascotas: false,
    fotos: [],
    raw: {},
  },
  {
    fincaId: 'F002',
    realName: 'Casa Girardot',
    zona: 'Girardot',
    ciudad: 'Girardot',
    capacidadMax: 10,
    precioPorNoche: 1200000,
    amenidades: ['piscina', 'jacuzzi'],
    mascotas: true,
    fotos: [],
    raw: {},
  },
  {
    fincaId: 'F003',
    realName: 'Finca Melgar',
    zona: 'Melgar',
    ciudad: 'Melgar',
    capacidadMax: 12,
    precioPorNoche: 1500000,
    amenidades: ['piscina'],
    mascotas: false,
    fotos: [],
    raw: {},
  },
];

beforeAll(async () => {
  const mod = await import('./loader.js');
  mod.__test_setCache(FIXTURE);
});

describe('matchFincas', () => {
  it('matches a single zona (string form)', async () => {
    const matches = await matchFincas({ personas: 6, zona: 'Carmen' });
    const ids = matches.map((m) => m.finca.fincaId);
    expect(ids).toContain('F001');
    // Other zones penalized but still returned (soft filter)
    expect(matches.length).toBeGreaterThan(0);
  });

  it('matches multiple zonas via OR (array form)', async () => {
    const matches = await matchFincas({ personas: 6, zona: ['Carmen', 'Girardot'] });
    const ids = matches.map((m) => m.finca.fincaId);
    expect(ids).toContain('F001');
    expect(ids).toContain('F002');
    // Both should have higher scores than F003 (Melgar — not requested)
    const f001Score = matches.find((m) => m.finca.fincaId === 'F001')!.score;
    const f003Score = matches.find((m) => m.finca.fincaId === 'F003')!.score;
    expect(f001Score).toBeGreaterThan(f003Score);
    // F001 and F002 should NOT have a "zona pedida vs zona finca" penalty in reasons
    const f001Reasons = matches.find((m) => m.finca.fincaId === 'F001')!.reasons;
    expect(f001Reasons.some((r) => r.includes('zona pedida'))).toBe(false);
    const f002Reasons = matches.find((m) => m.finca.fincaId === 'F002')!.reasons;
    expect(f002Reasons.some((r) => r.includes('zona pedida'))).toBe(false);
  });

  it('respects excludeIds', async () => {
    const matches = await matchFincas({ zona: ['Carmen', 'Girardot'], excludeIds: ['F001'] });
    const ids = matches.map((m) => m.finca.fincaId);
    expect(ids).not.toContain('F001');
    expect(ids).toContain('F002');
  });

  it('hard-filters fincas that do not allow mascotas when required', async () => {
    const matches = await matchFincas({ mascotas: true });
    const ids = matches.map((m) => m.finca.fincaId);
    expect(ids).toContain('F002'); // mascotas: true
    expect(ids).not.toContain('F001'); // mascotas: false
    expect(ids).not.toContain('F003');
  });

  it('hard-filters fincas with insufficient capacity', async () => {
    const matches = await matchFincas({ personas: 11 });
    const ids = matches.map((m) => m.finca.fincaId);
    expect(ids).not.toContain('F001'); // 8 max
    expect(ids).not.toContain('F002'); // 10 max
    expect(ids).toContain('F003'); // 12 max
  });
});
