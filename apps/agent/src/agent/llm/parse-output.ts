/**
 * Robust JSON extraction for LLM responses — direct port of v1's
 * `stripCodeFences` + `extractFirstJsonObject` + `escapeControlCharsInsideStrings`
 * + `safeParse` + `salvageParsedFromRaw` from `Code in JavaScript1`.
 *
 * Why this exists: Gemini ignores `responseMimeType: application/json` more
 * often than the docs claim. Real failure shapes we've observed:
 *   1. ```json\n{...}\n``` — markdown fences
 *   2. Trailing commentary after the closing brace
 *   3. Raw newlines inside string values (control chars → JSON.parse throws)
 *   4. Truncated output where the closing brace is missing
 *   5. {"intent": "QA", reasoning:"..."} — missing quotes on keys (rare)
 *
 * v1 layered four salvage strategies before giving up. Each layer is
 * independently testable and order-sensitive (cheaper layers first). The
 * orchestrator can call `parseLLMJson(rawText)` and only emit a fallback
 * when EVERY layer fails — drastically cutting the always-respond rate.
 */

/** Strip leading/trailing ```json or plain ``` fences. Idempotent. */
export function stripCodeFences(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  // Match an opening ``` optionally followed by a language hint, then
  // capture everything up to the closing ```.
  const fence = /^```(?:[a-zA-Z0-9]+)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = trimmed.match(fence);
  return (m?.[1] ?? trimmed).trim();
}

/**
 * Find the first balanced `{...}` block in the text. Walks character by
 * character respecting string literals and escapes, so a `{` inside a
 * string doesn't increment the depth counter.
 *
 * Returns null if no balanced object is found. Returns the substring
 * including the outer braces.
 */
export function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * JSON spec forbids raw control characters (codepoints < 0x20) inside string
 * literals — they must be escaped. Gemini occasionally emits a literal
 * newline or tab inside a `reasoning` field. This walks the text and
 * replaces those control chars (only when inside a string) with their
 * proper escape sequences, leaving everything else alone.
 */
export function escapeControlCharsInsideStrings(text: string): string {
  if (!text) return text;
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && code < 0x20) {
      // Replace with proper JSON escape
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Try to parse the text as JSON, applying salvage strategies in order:
 *   1. Plain JSON.parse
 *   2. Strip code fences then parse
 *   3. Extract first balanced {...} then parse
 *   4. Escape control chars inside strings, then parse
 *   5. Combine 2+3+4
 *
 * Returns the parsed object or null. Never throws.
 */
export function parseLLMJson(rawText: string): unknown {
  if (!rawText) return null;

  // Layer 1: as-is
  try {
    return JSON.parse(rawText);
  } catch {
    /* fall through */
  }

  // Layer 2: strip fences
  const noFences = stripCodeFences(rawText);
  if (noFences && noFences !== rawText) {
    try {
      return JSON.parse(noFences);
    } catch {
      /* fall through */
    }
  }

  // Layer 3: extract first balanced object
  const firstObj = extractFirstJsonObject(noFences || rawText);
  if (firstObj) {
    try {
      return JSON.parse(firstObj);
    } catch {
      /* fall through */
    }
  }

  // Layer 4: escape control chars on the un-fenced text
  const escaped = escapeControlCharsInsideStrings(noFences || rawText);
  if (escaped && escaped !== rawText) {
    try {
      return JSON.parse(escaped);
    } catch {
      /* fall through */
    }
  }

  // Layer 5: combine — extract first object then escape its control chars
  if (firstObj) {
    const escapedObj = escapeControlCharsInsideStrings(firstObj);
    try {
      return JSON.parse(escapedObj);
    } catch {
      /* fall through */
    }
  }

  return null;
}
