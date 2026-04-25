import { describe, it, expect } from 'vitest';
import { applyDeterministicRules } from './router.js';

describe('router rules', () => {
  it('routes mascotas FAQ to qa (the actual production silence cause)', () => {
    const r = applyDeterministicRules('¿Se pueden llevar mascotas?');
    expect(r?.destination).toBe('qa');
    expect(r?.reason).toContain('mascotas');
  });

  it('routes precio question to qa', () => {
    expect(applyDeterministicRules('cuánto cuesta?')?.destination).toBe('qa');
    expect(applyDeterministicRules('me dices la tarifa por favor')?.destination).toBe('qa');
  });

  it('routes hablar con humano to hitl', () => {
    expect(applyDeterministicRules('quiero hablar con un humano')?.destination).toBe('hitl');
    expect(applyDeterministicRules('Pásame con un asesor')?.destination).toBe('hitl');
  });

  it('returns null for normal qualifying messages (let stage handle)', () => {
    expect(applyDeterministicRules('Buenos días, busco finca para 8 personas')).toBeNull();
    expect(applyDeterministicRules('Para el 15 de mayo')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(applyDeterministicRules('')).toBeNull();
    expect(applyDeterministicRules('   ')).toBeNull();
  });
});
