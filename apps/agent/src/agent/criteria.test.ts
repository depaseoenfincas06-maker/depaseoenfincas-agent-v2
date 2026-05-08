import { describe, it, expect } from 'vitest';
import { compactCriteria, mergeCriteriaWithCurrent, uniqueCriteriaArray } from './criteria.js';

describe('uniqueCriteriaArray', () => {
  it('dedups case- and accent-insensitively, preserves first-seen casing', () => {
    expect(uniqueCriteriaArray(['Carmen', 'carmen', 'CÁRMEN', 'Girardot'])).toEqual([
      'Carmen',
      'Girardot',
    ]);
  });
  it('drops empty/whitespace strings', () => {
    expect(uniqueCriteriaArray(['', '  ', 'Anapoima'])).toEqual(['Anapoima']);
  });
  it('accepts a single string and wraps it', () => {
    expect(uniqueCriteriaArray('Carmen')).toEqual(['Carmen']);
  });
  it('returns [] for nullish/empty', () => {
    expect(uniqueCriteriaArray(null)).toEqual([]);
    expect(uniqueCriteriaArray(undefined)).toEqual([]);
    expect(uniqueCriteriaArray([])).toEqual([]);
  });
});

describe('compactCriteria', () => {
  it('drops empty arrays', () => {
    expect(compactCriteria({ zona: [], personas: 4 })).toEqual({ personas: 4 });
  });
  it('drops null/undefined and non-positive numbers', () => {
    expect(compactCriteria({ personas: 0, presupuestoMax: -1, mascotas: null })).toEqual({});
  });
  it('preserves valid mascotas boolean (including false)', () => {
    expect(compactCriteria({ mascotas: false })).toEqual({ mascotas: false });
    expect(compactCriteria({ mascotas: true })).toEqual({ mascotas: true });
  });
  it('compacts strings and dedups arrays', () => {
    expect(
      compactCriteria({
        zona: ['Carmen', 'CARMEN'],
        tipoEvento: ['cumpleaños'],
        fechaInicio: '  2026-05-15  ',
      }),
    ).toEqual({
      zona: ['Carmen'],
      tipoEvento: ['cumpleaños'],
      fechaInicio: '2026-05-15',
    });
  });
});

describe('mergeCriteriaWithCurrent', () => {
  it('unions zona arrays without duplicates', () => {
    const merged = mergeCriteriaWithCurrent(
      { zona: ['Carmen'] },
      { zona: ['Girardot', 'carmen'] },
    );
    expect(merged.zona).toEqual(['Carmen', 'Girardot']);
  });

  it('honours zona_remove ("ya no importa Carmen")', () => {
    const merged = mergeCriteriaWithCurrent(
      { zona: ['Carmen', 'Girardot'] },
      { zona_remove: ['Carmen'] },
    );
    expect(merged.zona).toEqual(['Girardot']);
  });

  it('zona_replace=true makes patch fully replace current', () => {
    const merged = mergeCriteriaWithCurrent(
      { zona: ['Carmen', 'Girardot'] },
      { zona: ['Anapoima'], zona_replace: true },
    );
    expect(merged.zona).toEqual(['Anapoima']);
  });

  it('numeric scalars: patch wins when positive, ignored when 0/negative', () => {
    expect(mergeCriteriaWithCurrent({ personas: 4 }, { personas: 8 })).toEqual({ personas: 8 });
    expect(mergeCriteriaWithCurrent({ personas: 4 }, { personas: 0 })).toEqual({ personas: 4 });
  });

  it('mascotas boolean: patch wins (including explicit false)', () => {
    expect(mergeCriteriaWithCurrent({ mascotas: true }, { mascotas: false })).toEqual({
      mascotas: false,
    });
  });

  it('removing all entries from a zona array drops the key entirely', () => {
    const merged = mergeCriteriaWithCurrent(
      { zona: ['Carmen'] },
      { zona_remove: ['Carmen'] },
    );
    expect(merged).toEqual({});
  });

  it('handles null current and null patch', () => {
    expect(mergeCriteriaWithCurrent(null, { zona: ['Carmen'] })).toEqual({ zona: ['Carmen'] });
    expect(mergeCriteriaWithCurrent({ zona: ['Carmen'] }, null)).toEqual({ zona: ['Carmen'] });
    expect(mergeCriteriaWithCurrent(null, null)).toEqual({});
  });

  it('does not mutate the inputs', () => {
    const cur = { zona: ['Carmen'] };
    const patch = { zona: ['Girardot'] };
    mergeCriteriaWithCurrent(cur, patch);
    expect(cur).toEqual({ zona: ['Carmen'] });
    expect(patch).toEqual({ zona: ['Girardot'] });
  });
});
