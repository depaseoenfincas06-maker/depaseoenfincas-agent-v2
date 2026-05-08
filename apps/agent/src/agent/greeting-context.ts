/**
 * Greeting context — direct port of v1's `Prepare qualifying greeting context`
 * JS node. Enriches the QUALIFYING stage prompt with three signals so the
 * agent's first message feels personal:
 *
 *   - is_initial_qualifying_turn: are we in QUALIFYING with no prior history?
 *   - greeting_time_bucket: morning/afternoon/night (Bogotá local time)
 *   - greeting_name_candidate: client name if it isn't a stopword
 *     (amor/bb/princesa/mi/etc.) — those are rejected because Chatwoot
 *     occasionally fills `name` with the contact's pet-name term, not their
 *     real name.
 */

const STOPWORD_NAMES = new Set([
  'amor',
  'amorcito',
  'amorcita',
  'bb',
  'bebe',
  'bebé',
  'bebito',
  'bebita',
  'mi',
  'mami',
  'mama',
  'mamá',
  'papi',
  'papa',
  'papá',
  'princesa',
  'princeso',
  'rey',
  'reina',
  'corazon',
  'corazón',
  'cielo',
  'gordo',
  'gorda',
  'flaco',
  'flaca',
  'cliente',
  'usuario',
  'unknown',
  'desconocido',
  'admin',
  '',
]);

export type TimeBucket = 'morning' | 'afternoon' | 'night';

export function bucketForBogotaHour(hour: number): TimeBucket {
  // Spanish saludo conventions:
  //   05–11 → buenos días (morning)
  //   12–18 → buenas tardes (afternoon)
  //   19–04 → buenas noches (night)
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 18) return 'afternoon';
  return 'night';
}

/** Compute current hour in Bogotá (UTC-5, no DST). Date.now() is UTC. */
export function bogotaHour(now: Date = new Date()): number {
  // Convert UTC to Bogota: subtract 5 hours, modulo 24.
  const utcHour = now.getUTCHours();
  return (utcHour - 5 + 24) % 24;
}

/** Tokenise + lower-case + strip accents to match against the stopword set. */
function dedupKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Strip a leading personal-form stopword. "amor María" → "María". */
export function pickGreetingName(rawName: string | null | undefined): string | null {
  if (!rawName) return null;
  const trimmed = rawName.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  // Reject if the WHOLE string is a stopword.
  const fullKey = dedupKey(trimmed);
  if (STOPWORD_NAMES.has(fullKey)) return null;
  // If first token is a stopword and there's more, drop it.
  const tokens = trimmed.split(' ');
  if (tokens.length > 1 && STOPWORD_NAMES.has(dedupKey(tokens[0]!))) {
    return tokens.slice(1).join(' ');
  }
  // Reject single-letter and two-letter "names" — Chatwoot occasionally
  // populates initials or typos like "Bz". Real first names start at 3+.
  if (trimmed.length < 3) return null;
  return trimmed;
}

export interface GreetingContext {
  isInitialQualifyingTurn: boolean;
  timeBucket: TimeBucket;
  greetingPhrase: string;
  nameCandidate: string | null;
}

export function buildGreetingContext(input: {
  currentStage: string;
  recentMessageCount: number;
  clientName: string | null | undefined;
  now?: Date;
}): GreetingContext {
  const isInitial = input.currentStage === 'QUALIFYING' && input.recentMessageCount <= 1;
  const bucket = bucketForBogotaHour(bogotaHour(input.now));
  const phrase =
    bucket === 'morning'
      ? 'Buenos días'
      : bucket === 'afternoon'
        ? 'Buenas tardes'
        : 'Buenas noches';
  const name = pickGreetingName(input.clientName ?? null);
  return {
    isInitialQualifyingTurn: isInitial,
    timeBucket: bucket,
    greetingPhrase: phrase,
    nameCandidate: name,
  };
}
