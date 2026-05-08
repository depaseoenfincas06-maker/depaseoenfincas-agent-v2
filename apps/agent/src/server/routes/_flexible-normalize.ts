/**
 * Flexible normalizer — accepts arbitrary JSON payloads from any messaging
 * platform (Chatwoot, Meta directly, custom integrations, future Chatwoot
 * versions with shifted shapes) and best-effort extracts:
 *
 *   - wa_id (the SENDER's phone number)
 *   - text content
 *   - external message id (wamid if present, else any id-shaped value)
 *   - whether it's incoming vs outgoing (skip outgoing — that's our own reply)
 *
 * Strategy: walk the object tree, collect all candidates by field-name
 * heuristics, score them, pick the best. If nothing usable found, return
 * a skip with details so we can debug from logs.
 *
 * This is a SAFETY NET — the strict Chatwoot normalizer in chatwoot-webhook.ts
 * runs first. We only fall back to this when strict says skip. That way we
 * keep the proven path for the common case and protect against
 * silently-dropped messages when the shape unexpectedly differs.
 */

export interface FlexibleResult {
  waId: string;
  text: string | null;
  externalMessageId: string | undefined;
  chatwootMessageId: string | undefined;
  chatwootConversationId: number | undefined;
  clientName: string | undefined;
  media:
    | {
        url: string;
        mimeType: string;
      }
    | undefined;
}

export interface FlexibleSkip {
  skip: true;
  reason: string;
  found: {
    phoneCandidates?: Array<{ value: string; path: string }>;
    textCandidates?: Array<{ value: string; path: string }>;
    outgoingMarkers?: Array<{ key: string; value: unknown; path: string }>;
  };
}

const PHONE_FIELDS = new Set([
  'source_id',
  'identifier',
  'phone_number',
  'phone',
  'wa_id',
  'from',
  'from_id',
  'wa_from',
  'msisdn',
]);

// Fields likely to contain the SENDER's identity (not the recipient/agent)
const SENDER_CONTEXT_KEYS = ['contact', 'sender', 'from', 'source', 'user', 'inbox'];
// Fields that suggest we're looking at a recipient or agent (skip these)
const NON_SENDER_CONTEXT_KEYS = ['agent', 'recipient', 'to', 'assignee', 'admin', 'team', 'inbox_id'];

const TEXT_FIELDS = new Set(['content', 'text', 'body', 'message', 'caption', 'transcript']);

const OUTGOING_MARKERS = [
  // Numeric: 1 = outgoing in Chatwoot, also some platforms
  { key: 'message_type', test: (v: unknown) => v === 1 || v === '1' || v === 'outgoing' },
  { key: 'direction', test: (v: unknown) => typeof v === 'string' && /^(out|outbound|outgoing)/i.test(v) },
  { key: 'sender_type', test: (v: unknown) => typeof v === 'string' && /^(user|agent|bot|system)/i.test(v) },
  { key: 'is_private', test: (v: unknown) => v === true },
  { key: 'private', test: (v: unknown) => v === true },
];

function isPhoneShape(s: unknown): s is string {
  return typeof s === 'string' && /^\+?\d{10,15}$/.test(s.trim());
}

function normalizePhone(s: string): string {
  return s.replace(/[^\d]/g, '');
}

function pathContextSuggests(path: string[], hints: string[]): boolean {
  const lower = path.map((p) => p.toLowerCase());
  return lower.some((seg) => hints.some((hint) => seg.includes(hint)));
}

function isOutgoing(payload: unknown): { outgoing: boolean; markers: Array<{ key: string; value: unknown; path: string }> } {
  const found: Array<{ key: string; value: unknown; path: string }> = [];
  walk(payload, (key, value, path) => {
    for (const marker of OUTGOING_MARKERS) {
      if (key === marker.key && marker.test(value)) {
        found.push({ key, value, path: path.join('.') });
      }
    }
  });
  // If we see at least one strong outgoing marker on a "message" path, it's outgoing.
  // We're conservative: a single sender_type=User in a nested old message doesn't
  // mean the CURRENT message is outgoing. Check if it's on a top-level or near-top
  // path or if message_type=1 specifically.
  const decisive = found.filter(
    (m) =>
      m.key === 'message_type' ||
      m.key === 'direction' ||
      m.path.split('.').length <= 4, // shallow-enough to be the firing message
  );
  return { outgoing: decisive.length > 0 && found.some((m) => m.key === 'message_type' || m.key === 'direction'), markers: found };
}

function walk(
  obj: unknown,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
  depth = 0,
): void {
  if (depth > 12) return; // safety
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, visit, [...path, String(i)], depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    visit(key, value, [...path, key]);
    if (value !== null && typeof value === 'object') {
      walk(value, visit, [...path, key], depth + 1);
    }
  }
}

function collectPhoneCandidates(payload: unknown): Array<{ value: string; path: string; score: number }> {
  const out: Array<{ value: string; path: string; score: number }> = [];
  walk(payload, (key, value, path) => {
    if (!PHONE_FIELDS.has(key)) return;
    if (!isPhoneShape(value)) return;
    const phone = normalizePhone(value as string);
    if (phone.length < 10 || phone.length > 15) return;
    // Score: prefer paths that mention sender/contact, demote agent/recipient
    let score = 0;
    if (pathContextSuggests(path, SENDER_CONTEXT_KEYS)) score += 3;
    if (pathContextSuggests(path, NON_SENDER_CONTEXT_KEYS)) score -= 5;
    // Prefer fields literally named source_id (Chatwoot's wa_id)
    if (key === 'source_id') score += 2;
    if (key === 'wa_id') score += 3;
    if (key === 'identifier') score += 2;
    if (key === 'phone_number' || key === 'msisdn') score += 1;
    out.push({ value: phone, path: path.join('.'), score });
  });
  return out;
}

function collectTextCandidates(payload: unknown): Array<{ value: string; path: string; score: number }> {
  const out: Array<{ value: string; path: string; score: number }> = [];
  walk(payload, (key, value, path) => {
    if (typeof value !== 'string') return;
    if (!TEXT_FIELDS.has(key)) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    let score = 0;
    // Top-level wins over deep matches (avoids picking historical messages)
    score -= path.length * 0.5;
    // "content" with content_type "text" nearby? Just use depth heuristic.
    if (key === 'content') score += 1;
    out.push({ value: trimmed, path: path.join('.'), score });
  });
  return out;
}

function findWamid(payload: unknown): { wamid?: string; chatwootMessageId?: string } {
  let wamid: string | undefined;
  let chatwootId: string | undefined;
  walk(payload, (key, value, _path) => {
    if (typeof value === 'string' && value.startsWith('wamid.') && !wamid) {
      wamid = value;
    }
    // Also collect a numeric "id" near message contexts
    if (key === 'id' && (typeof value === 'number' || typeof value === 'string') && !chatwootId) {
      // Only adopt if path suggests it's a message id (not an account id)
      // We accept loosely; dedup keys are mostly wamids anyway.
      chatwootId = String(value);
    }
  });
  return { wamid, chatwootMessageId: chatwootId };
}

function findClientName(payload: unknown): string | undefined {
  let bestName: string | undefined;
  let bestScore = -Infinity;
  walk(payload, (key, value, path) => {
    if (typeof value !== 'string') return;
    if (key !== 'name') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'chatwoot') return; // chatwoot account name
    let score = 0;
    if (pathContextSuggests(path, ['sender', 'contact'])) score += 2;
    if (pathContextSuggests(path, ['account', 'inbox', 'team'])) score -= 3;
    if (score > bestScore) {
      bestScore = score;
      bestName = trimmed;
    }
  });
  return bestName;
}

function findConversationId(payload: unknown): number | undefined {
  // Look for a `conversation.id` near the top
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    const conv = p.conversation as Record<string, unknown> | undefined;
    if (conv?.id != null) {
      const n = Number(conv.id);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function findMedia(payload: unknown): FlexibleResult['media'] {
  let media: FlexibleResult['media'];
  walk(payload, (key, value) => {
    if (media) return;
    if (key !== 'attachments') return;
    if (!Array.isArray(value) || value.length === 0) return;
    const att = value[0] as Record<string, unknown>;
    const url = att.data_url ?? att.url ?? att.media_url;
    if (typeof url !== 'string') return;
    const fileType = (att.file_type ?? att.type ?? '') as string;
    const mimeMap: Record<string, string> = {
      audio: 'audio/ogg',
      image: 'image/jpeg',
      video: 'video/mp4',
      file: 'application/octet-stream',
    };
    media = {
      url,
      mimeType: mimeMap[fileType] ?? (typeof att.content_type === 'string' ? att.content_type : 'application/octet-stream'),
    };
  });
  return media;
}

/**
 * Best-effort normalize. Returns the data we extracted, or a skip with the
 * reason and what we DID find (so we can iterate the heuristic from logs).
 */
export function flexibleNormalize(payload: unknown): FlexibleResult | FlexibleSkip {
  const phones = collectPhoneCandidates(payload);
  const texts = collectTextCandidates(payload);
  const { outgoing, markers } = isOutgoing(payload);

  if (outgoing) {
    return {
      skip: true,
      reason: 'outgoing message (agent reply or system) — skipping',
      found: { outgoingMarkers: markers },
    };
  }

  if (phones.length === 0) {
    return {
      skip: true,
      reason: 'no phone-like wa_id found in any recognizable field',
      found: { phoneCandidates: phones.map((p) => ({ value: p.value, path: p.path })), textCandidates: texts.map((t) => ({ value: t.value, path: t.path })) },
    };
  }

  // Pick highest-scoring phone
  phones.sort((a, b) => b.score - a.score);
  const waId = phones[0]!.value;

  // Pick best text (or null if none — still acceptable for media-only messages)
  texts.sort((a, b) => b.score - a.score);
  const text = texts[0]?.value ?? null;

  const { wamid, chatwootMessageId } = findWamid(payload);
  const clientName = findClientName(payload);
  const chatwootConversationId = findConversationId(payload);
  const media = findMedia(payload);

  return {
    waId,
    text,
    externalMessageId: wamid ?? chatwootMessageId,
    chatwootMessageId,
    chatwootConversationId,
    clientName,
    media,
  };
}
