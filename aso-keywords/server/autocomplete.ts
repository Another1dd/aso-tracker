import { db } from './db.js';
import type { AppConfig } from './config.js';
import { GateHttpError, hostGate, type GatePriority } from './host-gate.js';
import { storeFrontHeader } from './storefront-ids.js';

// App Store search autocomplete ("hints"): persisted per day so runs are reproducible, and the
// shortest prefix at which Apple suggests a phrase ("keystroke depth") is the one demand signal
// that still varies when Apple Ads popularity sits at its floor of 5. The relationship between
// depth and real volume is unproven (see docs/plans/keyword-demand-and-audit.md); every value
// carries a provisional band and is an estimate.

db.exec(`
  CREATE TABLE IF NOT EXISTS autocomplete_hints (
    country    TEXT NOT NULL,
    prefix     TEXT NOT NULL,
    day        TEXT NOT NULL,
    status     TEXT NOT NULL,
    hints_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (country, prefix, day)
  );
`);

const HOUR_MS = 60 * 60_000;
const ERROR_MEMORY_MS = 10 * 60_000;
const LATIN = 'abcdefghijklmnopqrstuvwxyz';
const CYRILLIC = 'абвгдежзийклмнопрстуфхцчшщэюя';
/** Provisional: a hit within this share of the phrase length counts as "early". Tuned in validation. */
const EARLY_RATIO = 0.6;

export const normalizeHint = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

function decodeXML(value: string) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const today = () => new Date().toISOString().slice(0, 10);
const errorAt = new Map<string, number>();

export type HintResult = { status: 'ok'; hints: string[]; cached: boolean } | { status: 'error' };

/** Latest stored hint list for a prefix, or null when none is fresh enough. Errors never count. */
export function cachedHints(country: string, prefix: string, maxAgeMs = 14 * 24 * HOUR_MS): string[] | null {
  const row = db.prepare(
    `SELECT hints_json FROM autocomplete_hints WHERE country = ? AND prefix = ? AND status = 'ok' AND fetched_at > ? ORDER BY fetched_at DESC LIMIT 1`
  ).get(country, prefix, Date.now() - maxAgeMs) as { hints_json: string } | undefined;
  return row ? (JSON.parse(row.hints_json) as string[]) : null;
}

export async function fetchHints(
  country: string,
  rawPrefix: string,
  options: { priority?: GatePriority; maxAgeMs?: number } = {},
): Promise<HintResult> {
  const prefix = normalizeHint(rawPrefix);
  const cached = cachedHints(country, prefix, options.maxAgeMs);
  if (cached) return { status: 'ok', hints: cached, cached: true };

  const storefront = storeFrontHeader(country) ?? storeFrontHeader('us')!;
  const params = new URLSearchParams({ clientApplication: 'Software', term: prefix });
  try {
    // Hints share the search.itunes.apple.com budget with MZStore rank checks.
    const xml = await hostGate('search.itunes.apple.com').run(async (via) => {
      const response = await via.fetch(
        `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?${params}`,
        { headers: { 'X-Apple-Store-Front': storefront }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new GateHttpError(response.status);
      return response.text();
    }, { key: `hints|${country}|${prefix}`, priority: options.priority ?? 'tail' });
    const hints = Array.from(xml.matchAll(/<key>term<\/key>\s*<string>([\s\S]*?)<\/string>/g))
      .map((match) => normalizeHint(decodeXML(match[1])))
      .filter(Boolean);
    db.prepare(
      `INSERT INTO autocomplete_hints (country, prefix, day, status, hints_json, fetched_at) VALUES (?, ?, ?, 'ok', ?, ?)
       ON CONFLICT(country, prefix, day) DO UPDATE SET status = 'ok', hints_json = excluded.hints_json, fetched_at = excluded.fetched_at`
    ).run(country, prefix, today(), JSON.stringify(hints), Date.now());
    return { status: 'ok', hints, cached: false };
  } catch {
    errorAt.set(`${country}|${prefix}`, Date.now());
    db.prepare(
      `INSERT OR IGNORE INTO autocomplete_hints (country, prefix, day, status, hints_json, fetched_at) VALUES (?, ?, ?, 'error', '[]', ?)`
    ).run(country, prefix, today(), Date.now());
    return { status: 'error' };
  }
}

/** The seed itself plus seed + one letter: the "second word, first letter" prefixes double as depth data. */
export function alphabetSoup(seed: string, country: string): string[] {
  const letters = country === 'ru' || country === 'ua' || country === 'kz' ? CYRILLIC : LATIN;
  return [seed, ...Array.from(letters, (letter) => `${seed} ${letter}`)];
}

/** Prefixes to type, shortest first, at most six: whole earlier words, then one or two letters of the next. */
export function probesFor(phrase: string): string[] {
  const words = phrase.split(' ');
  const out = new Set<string>();
  if (words.length === 1) {
    for (const size of [3, 4, 5, 6, 8]) if (size < words[0].length) out.add(words[0].slice(0, size));
    out.add(words[0]);
  } else {
    for (let index = 1; index < words.length; index++) {
      const base = words.slice(0, index).join(' ');
      const next = words[index];
      out.add(base);
      out.add(`${base} ${next.slice(0, 1)}`);
      out.add(`${base} ${next.slice(0, 2)}`);
    }
  }
  return [...out].sort((a, b) => a.length - b.length).slice(0, 6);
}

export type Depth =
  | { status: 'hit'; match: 'exact' | 'extended'; chars: number; ratio: number; position: number; total: number; prefix: string }
  | { status: 'never'; probes: number }
  | { status: 'pending' }
  | { status: 'error' };

/** Walks the probes in order using stored hints only (`fetch: true` fills the gaps, stopping at the first hit). */
export async function suggestDepth(rawPhrase: string, country: string, options: { fetch?: boolean } = {}): Promise<Depth> {
  const phrase = normalizeHint(rawPhrase);
  const probes = probesFor(phrase);
  let sawError = false;
  // A hint that only starts with the phrase ("hot flash tracker" for "hot flash") is weaker evidence: keep looking for an exact one.
  let extended: Depth | null = null;
  for (const prefix of probes) {
    let hints = cachedHints(country, prefix);
    if (!hints) {
      const failedRecently = Date.now() - (errorAt.get(`${country}|${prefix}`) ?? 0) < ERROR_MEMORY_MS;
      if (failedRecently) { sawError = true; continue; }
      if (!options.fetch) return { status: 'pending' };
      const result = await fetchHints(country, prefix);
      if (result.status === 'error') { sawError = true; continue; }
      hints = result.hints;
    }
    const ratio = Math.round((prefix.length / phrase.length) * 100) / 100;
    const index = hints.indexOf(phrase);
    if (index >= 0) return { status: 'hit', match: 'exact', chars: prefix.length, ratio, position: index + 1, total: hints.length, prefix };
    const longer = hints.findIndex((hint) => hint.startsWith(`${phrase} `));
    if (longer >= 0 && !extended) extended = { status: 'hit', match: 'extended', chars: prefix.length, ratio, position: longer + 1, total: hints.length, prefix };
  }
  if (extended) return extended;
  return sawError ? { status: 'error' } : { status: 'never', probes: probes.length };
}

export type DemandBand = 'A' | 'B' | 'C' | 'D' | 'unknown';

/** A: Apple value above 5 (fact). Below it: B suggested early, C late, D never suggested (estimates). */
export function demandBand(popularity: number | null, depth: Depth): { band: DemandBand; confidence: 'high' | 'medium' | 'low' | 'unknown'; note: string } {
  if (popularity != null && popularity > 5) return { band: 'A', confidence: 'high', note: 'значение Apple выше порога (факт)' };
  if (depth.status === 'hit') {
    const how = depth.match === 'exact' ? 'подсказка' : 'подсказка-продолжение (в составе более длинной фразы)';
    return depth.ratio <= EARLY_RATIO
      ? { band: 'B', confidence: 'low', note: `на границе Apple; ${how} появляется после ${depth.chars} симв. (оценка)` }
      : { band: 'C', confidence: 'low', note: `на границе Apple; ${how} появляется только после ${depth.chars} симв. (оценка)` };
  }
  if (depth.status === 'never') return { band: 'D', confidence: 'low', note: 'на границе Apple и не предлагается в подсказках (оценка)' };
  return { band: 'unknown', confidence: 'unknown', note: depth.status === 'error' ? 'запрос подсказок не удался' : 'подсказки ещё собираются' };
}

// --- Background queue ---------------------------------------------------------------------

const queue: Array<{ country: string; term: string }> = [];
let draining: Promise<void> | null = null;

function drain() {
  draining ??= (async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await suggestDepth(item.term, item.country, { fetch: true });
  })().finally(() => { draining = null; });
  return draining;
}

/** Queues terms whose depth is not resolvable from stored hints and waits up to `waitMs` for the queue. */
export async function ensureDepth(country: string, terms: string[], waitMs: number): Promise<number> {
  for (const term of terms) {
    if ((await suggestDepth(term, country)).status === 'pending' && !queue.some((item) => item.country === country && item.term === term)) queue.push({ country, term });
  }
  if (queue.length) await Promise.race([drain(), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return queue.length + (draining ? 1 : 0);
}

export const soupJob: { running: { appId: string; storefront: string; total: number; done: number; errors: number } | null; last: string | null } = { running: null, last: null };

export async function collectSoup(appId: string, country: string, seeds: string[]): Promise<void> {
  const prefixes = [...new Set(seeds.flatMap((seed) => alphabetSoup(seed, country)))];
  const job = { appId, storefront: country, total: prefixes.length, done: 0, errors: 0 };
  soupJob.running = job;
  try {
    for (const prefix of prefixes) {
      const result = await fetchHints(country, prefix);
      job.done++;
      if (result.status === 'error') job.errors++;
    }
    soupJob.last = `${appId} ${country}: ${job.done} prefixes, ${job.errors} errors, ${new Date().toISOString()}`;
  } finally {
    soupJob.running = null;
  }
}

// --- Topic anchors ------------------------------------------------------------------------

const GENERIC_ANCHOR_WORDS = new Set(['tracker', 'tracking', 'log', 'journal', 'diary', 'app', 'apps', 'free', 'health', 'symptom', 'symptoms', 'night']);

const fold = (value: string) => normalizeHint(value).normalize('NFD').replace(/\p{M}/gu, '');
const wordsOf = (value: string) => fold(value).match(/[\p{L}\p{N}]+\*?/gu) ?? [];

/** Whole-word (sequence) match, accent-insensitive; a trailing `*` on an anchor word means "starts with". */
export function matchesAnchor(phrase: string, anchor: string): boolean {
  const tokens = wordsOf(phrase);
  const want = wordsOf(anchor);
  if (!want.length) return false;
  for (let start = 0; start + want.length <= tokens.length; start++) {
    if (want.every((word, offset) => (word.endsWith('*') ? tokens[start + offset].startsWith(word.slice(0, -1)) : tokens[start + offset] === word))) return true;
  }
  return false;
}

export interface AnchorRule { anchors: string[] | null; excluded: string[]; defaults: Set<string> }

/** Explicit anchors for the storefront (or "*"), else tracked-keyword words minus generic ones. */
export function anchorRule(app: AppConfig | undefined, storefront: string, trackedTokens: Iterable<string>): AnchorRule {
  const explicit = app?.anchors?.[storefront] ?? app?.anchors?.['*'] ?? null;
  const excluded = [...(app?.excludeAnchors?.['*'] ?? []), ...(app?.excludeAnchors?.[storefront] ?? [])];
  return { anchors: explicit && explicit.length ? explicit : null, excluded, defaults: new Set([...trackedTokens].map(fold).filter((token) => !GENERIC_ANCHOR_WORDS.has(token))) };
}

/** Why a phrase is off-topic under the rule, or null when it passes. */
export function anchorProblem(phrase: string, rule: AnchorRule): string | null {
  if (rule.excluded.some((word) => matchesAnchor(phrase, word))) return 'слово из списка исключённых опорных слов';
  if (rule.anchors) return rule.anchors.some((anchor) => matchesAnchor(phrase, anchor)) ? null : 'нет опорного слова темы приложения';
  return wordsOf(phrase).some((word) => rule.defaults.has(word)) ? null : 'нет общих слов с отслеживаемыми ключами (без общих слов вроде «tracker»)';
}
