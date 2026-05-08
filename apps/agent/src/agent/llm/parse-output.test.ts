import { describe, it, expect } from 'vitest';
import {
  stripCodeFences,
  extractFirstJsonObject,
  escapeControlCharsInsideStrings,
  parseLLMJson,
} from './parse-output.js';

describe('stripCodeFences', () => {
  it('strips ```json ... ```', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips plain ``` ... ```', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('returns text untouched when no fences', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
  it('handles no closing newline before fence', () => {
    expect(stripCodeFences('```json\n{"a":1}```')).toBe('{"a":1}');
  });
});

describe('extractFirstJsonObject', () => {
  it('finds the first balanced object', () => {
    expect(extractFirstJsonObject('preamble {"a":1} trailing')).toBe('{"a":1}');
  });
  it('handles nested objects', () => {
    expect(extractFirstJsonObject('{"a":{"b":2},"c":[1,2]}')).toBe(
      '{"a":{"b":2},"c":[1,2]}',
    );
  });
  it('respects strings — { inside a string does not increment depth', () => {
    expect(extractFirstJsonObject('{"text":"a { brace inside"}')).toBe(
      '{"text":"a { brace inside"}',
    );
  });
  it('respects escaped quotes', () => {
    expect(extractFirstJsonObject('{"q":"he said \\"hi\\""}')).toBe(
      '{"q":"he said \\"hi\\""}',
    );
  });
  it('returns null when no balanced object present', () => {
    expect(extractFirstJsonObject('just some text')).toBeNull();
    expect(extractFirstJsonObject('{ unclosed')).toBeNull();
  });
});

describe('escapeControlCharsInsideStrings', () => {
  it('escapes a raw newline inside a string', () => {
    const input = '{"r":"line1\nline2"}';
    const out = escapeControlCharsInsideStrings(input);
    expect(out).toBe('{"r":"line1\\nline2"}');
    // ...and the result is now valid JSON
    expect(() => JSON.parse(out)).not.toThrow();
  });
  it('leaves outside-string whitespace alone', () => {
    const input = '{\n  "a": 1\n}';
    const out = escapeControlCharsInsideStrings(input);
    // Newlines outside strings are valid, should remain
    expect(out).toBe('{\n  "a": 1\n}');
  });
  it('handles tabs inside strings', () => {
    const out = escapeControlCharsInsideStrings('{"x":"a\tb"}');
    expect(out).toBe('{"x":"a\\tb"}');
  });
});

describe('parseLLMJson', () => {
  it('parses plain JSON', () => {
    expect(parseLLMJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(parseLLMJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses JSON with trailing commentary', () => {
    expect(parseLLMJson('{"a":1}\n\nThat is my answer.')).toEqual({ a: 1 });
  });
  it('parses JSON with leading commentary + fences', () => {
    expect(parseLLMJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });
  it('parses JSON with raw newlines inside string values', () => {
    const input = '{"reasoning":"step 1\nstep 2","intent":"QA"}';
    expect(parseLLMJson(input)).toEqual({ reasoning: 'step 1\nstep 2', intent: 'QA' });
  });
  it('returns null for unrecoverable input', () => {
    expect(parseLLMJson('totally not json')).toBeNull();
    expect(parseLLMJson('')).toBeNull();
  });
  it('returns null for null/undefined', () => {
    expect(parseLLMJson(null as unknown as string)).toBeNull();
  });
});
