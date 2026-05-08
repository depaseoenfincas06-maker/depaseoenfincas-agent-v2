/**
 * Unit tests for orchestrator helpers. Heavy integration paths are covered by
 * the eval suite (apps/agent/tests/evals/silences.jsonl) which exercises the
 * full pipeline against real Postgres + Gemini. These tests target pure
 * functions only.
 */
import { describe, it, expect } from 'vitest';
import { renderInitialGreeting } from './orchestrator.js';

describe('renderInitialGreeting', () => {
  it('substitutes {client_name} with leading space when name is present', () => {
    const out = renderInitialGreeting('Hola{client_name}, ¿cómo estás?', 'María');
    expect(out).toBe('Hola María, ¿cómo estás?');
  });

  it('drops the placeholder cleanly when no name available', () => {
    const out = renderInitialGreeting('Hola{client_name}, ¿cómo estás?', null);
    expect(out).toBe('Hola, ¿cómo estás?');
  });

  it('handles {clientName} camelCase variant', () => {
    expect(renderInitialGreeting('Hola{clientName}, ...', 'Juan')).toBe('Hola Juan, ...');
  });

  it('handles {name} bare variant without prepending space', () => {
    expect(renderInitialGreeting('Hola, soy {name}', 'Santi')).toBe('Hola, soy Santi');
  });

  it('passes through templates with no placeholders unchanged', () => {
    const tpl =
      'Excelente día!🤩🌅\nMi nombre es Santiago Gallego\nDepaseoenfincas.com, estaré frente a tu reserva!⚡\nPor favor indícame:\n*Fechas exactas?';
    expect(renderInitialGreeting(tpl, null)).toBe(tpl);
    expect(renderInitialGreeting(tpl, 'Cliente')).toBe(tpl);
  });

  it('collapses accidental double spaces from empty substitution', () => {
    expect(renderInitialGreeting('Hola {client_name} ¿qué tal?', null)).toBe('Hola ¿qué tal?');
  });

  it('trims whitespace around the substituted name', () => {
    expect(renderInitialGreeting('Hola{client_name},', '  María  ')).toBe('Hola María,');
  });
});
