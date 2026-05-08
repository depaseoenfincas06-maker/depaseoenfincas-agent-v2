import { describe, it, expect } from 'vitest';
import {
  bucketForBogotaHour,
  bogotaHour,
  pickGreetingName,
  buildGreetingContext,
} from './greeting-context.js';

describe('bucketForBogotaHour', () => {
  it('5–11 → morning', () => {
    expect(bucketForBogotaHour(5)).toBe('morning');
    expect(bucketForBogotaHour(7)).toBe('morning');
    expect(bucketForBogotaHour(11)).toBe('morning');
  });
  it('12–18 → afternoon', () => {
    expect(bucketForBogotaHour(12)).toBe('afternoon');
    expect(bucketForBogotaHour(15)).toBe('afternoon');
    expect(bucketForBogotaHour(18)).toBe('afternoon');
  });
  it('19–04 → night', () => {
    expect(bucketForBogotaHour(19)).toBe('night');
    expect(bucketForBogotaHour(23)).toBe('night');
    expect(bucketForBogotaHour(0)).toBe('night');
    expect(bucketForBogotaHour(4)).toBe('night');
  });
});

describe('bogotaHour', () => {
  it('returns UTC-5 hour, with wrap-around', () => {
    expect(bogotaHour(new Date(Date.UTC(2026, 4, 8, 17, 0, 0)))).toBe(12); // 17 UTC → 12 Bogotá
    expect(bogotaHour(new Date(Date.UTC(2026, 4, 8, 2, 0, 0)))).toBe(21); // 2 UTC → 21 prev day
  });
});

describe('pickGreetingName', () => {
  it('returns the trimmed name when it is a real one', () => {
    expect(pickGreetingName('María')).toBe('María');
    expect(pickGreetingName('  Juan Pérez  ')).toBe('Juan Pérez');
  });
  it('rejects whole-string stopwords', () => {
    expect(pickGreetingName('amor')).toBeNull();
    expect(pickGreetingName('Princesa')).toBeNull();
    expect(pickGreetingName('mami')).toBeNull();
    expect(pickGreetingName('Cliente')).toBeNull();
  });
  it('strips a leading stopword if more tokens follow', () => {
    expect(pickGreetingName('amor María')).toBe('María');
    expect(pickGreetingName('mami Juan')).toBe('Juan');
  });
  it('returns null for null/empty', () => {
    expect(pickGreetingName(null)).toBeNull();
    expect(pickGreetingName(undefined)).toBeNull();
    expect(pickGreetingName('')).toBeNull();
    expect(pickGreetingName('   ')).toBeNull();
  });
  it('rejects very short strings', () => {
    expect(pickGreetingName('A')).toBeNull();
    expect(pickGreetingName('Bz')).toBeNull();
  });
});

describe('buildGreetingContext', () => {
  it('flags initial QUALIFYING turn when history is 0–1 messages', () => {
    const ctx = buildGreetingContext({
      currentStage: 'QUALIFYING',
      recentMessageCount: 1,
      clientName: 'María',
      now: new Date(Date.UTC(2026, 4, 8, 14, 0, 0)), // 09:00 Bogotá → morning
    });
    expect(ctx.isInitialQualifyingTurn).toBe(true);
    expect(ctx.timeBucket).toBe('morning');
    expect(ctx.greetingPhrase).toBe('Buenos días');
    expect(ctx.nameCandidate).toBe('María');
  });
  it('does not flag initial when stage is not QUALIFYING', () => {
    const ctx = buildGreetingContext({
      currentStage: 'OFFERING',
      recentMessageCount: 0,
      clientName: null,
      now: new Date(),
    });
    expect(ctx.isInitialQualifyingTurn).toBe(false);
  });
  it('does not flag initial when there is conversation history', () => {
    const ctx = buildGreetingContext({
      currentStage: 'QUALIFYING',
      recentMessageCount: 4,
      clientName: 'María',
      now: new Date(),
    });
    expect(ctx.isInitialQualifyingTurn).toBe(false);
  });
});
