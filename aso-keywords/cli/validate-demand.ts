#!/usr/bin/env tsx
// Does the autocomplete depth signal carry information about Apple Ads popularity? Read-only over the
// Ads database; the depths themselves are collected through a running studio (POST /demand).
//
//   npx tsx cli/validate-demand.ts [--base=http://127.0.0.1:5173] [--db=../asa-ads/data/asa-ads.db] [--country=us]
//   npx tsx cli/validate-demand.ts --stability=2026-09-30,2026-10-01   (second run, offline over stored hints)
//
//   npx tsx cli/validate-demand.ts --refresh=100   (refetch today's hints for a fixed sample, for the stability check)
// Rules and thresholds: docs/plans/keyword-demand-and-audit.md (P3). Prints a verdict, writes nothing.
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { probesFor } from '../server/autocomplete.js';

type Depth = { status: string; match?: string; ratio?: number };
interface Sample { term: string; popularity: number; appId: string; signal: number | null }

function args() {
  const values: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** Larger is more strongly suggested: exact hit 1 - ratio, extended half of it, never 0, unknown excluded. */
export function signalOf(depth: Depth): number | null {
  if (depth.status === 'hit') return (depth.match === 'exact' ? 1 : 0.5) * (1 - (depth.ratio ?? 1));
  if (depth.status === 'never') return 0;
  return null;
}

function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let k = i; k <= j; k++) out[order[k].index] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** Probability that a term above the floor has a stronger signal than one at the floor (ties count half). */
export function auc(signalAbove: number[], signalFloor: number[]): number {
  let wins = 0;
  for (const x of signalAbove) for (const y of signalFloor) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return wins / (signalAbove.length * signalFloor.length);
}

export function kendallTau(a: number[], b: number[]): number {
  let concordant = 0; let discordant = 0; let tiesA = 0; let tiesB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i] - a[j]); const db = Math.sign(b[i] - b[j]);
      if (da === 0 && db === 0) continue;
      if (da === 0) tiesA++; else if (db === 0) tiesB++; else if (da === db) concordant++; else discordant++;
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  return denom ? (concordant - discordant) / denom : NaN;
}

const f = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : 'n/a');

function report(label: string, samples: Sample[]) {
  const usable = samples.filter((sample) => sample.signal != null);
  const above = usable.filter((sample) => sample.popularity > 5);
  const floor = usable.filter((sample) => sample.popularity <= 5);
  const rho = usable.length > 2 ? spearman(usable.map((s) => s.signal!), usable.map((s) => s.popularity)) : NaN;
  const area = above.length && floor.length ? auc(above.map((s) => s.signal!), floor.map((s) => s.signal!)) : NaN;
  // Control: does depth beat "short phrases are more popular"? Also AUC within word-count strata.
  const shortAuc = above.length && floor.length ? auc(above.map((s) => -s.term.length), floor.map((s) => -s.term.length)) : NaN;
  const strata = [1, 2, 3].map((words) => {
    const inStratum = usable.filter((s) => Math.min(s.term.split(' ').length, 3) === words);
    const up = inStratum.filter((s) => s.popularity > 5); const down = inStratum.filter((s) => s.popularity <= 5);
    return up.length >= 5 && down.length >= 5 ? `${words === 3 ? '3+' : words} words ${f(auc(up.map((s) => s.signal!), down.map((s) => s.signal!)))} (n ${up.length}/${down.length})` : `${words === 3 ? '3+' : words} words n/a`;
  });
  console.log(`${label}: terms ${samples.length}, usable ${usable.length}, above 5: ${above.length}, floor: ${floor.length}, Spearman ${f(rho)}, AUC ${f(area)}; control AUC of phrase shortness ${f(shortAuc)}; depth AUC within strata: ${strata.join(', ')}`);
  return { rho, area, above: above.length };
}

async function depthsFor(base: string, appId: string, country: string, terms: string[]): Promise<Map<string, Depth>> {
  const out = new Map<string, Depth>();
  const deadline = Date.now() + 90 * 60_000;
  for (let i = 0; i < terms.length; i += 50) {
    const chunk = terms.slice(i, i + 50);
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/apps/${appId}/demand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storefront: country, terms: chunk, wait_ms: 50_000 }),
      });
      if (!response.ok) throw new Error(`demand ${response.status}`);
      const data = await response.json() as { items: Array<{ term: string; depth: Depth }>; pending: number };
      for (const item of data.items) out.set(item.term, item.depth);
      if (data.items.every((item) => item.depth.status !== 'pending')) break;
    }
    console.error(`depth ${Math.min(i + 50, terms.length)}/${terms.length}`);
  }
  return out;
}

/** Depth recomputed offline from the hint lists stored on one day (probes are the same). */
function depthOnDay(hintsDb: Database.Database, country: string, day: string, term: string): Depth {
  let missing = false;
  let extended: Depth | null = null;
  for (const prefix of probesFor(term)) {
    const row = hintsDb.prepare(`SELECT hints_json FROM autocomplete_hints WHERE country = ? AND prefix = ? AND day = ? AND status = 'ok'`).get(country, prefix, day) as { hints_json: string } | undefined;
    if (!row) { missing = true; continue; }
    const hints = JSON.parse(row.hints_json) as string[];
    const ratio = prefix.length / term.length;
    if (hints.includes(term)) return { status: 'hit', match: 'exact', ratio };
    if (!extended && hints.some((hint) => hint.startsWith(`${term} `))) extended = { status: 'hit', match: 'extended', ratio };
  }
  return extended ?? (missing ? { status: 'pending' } : { status: 'never' });
}

async function main() {
  const options = args();
  const country = (options.country ?? 'us').toLowerCase();
  if (options.stability) {
    const [dayA, dayB] = options.stability.split(',');
    const hintsDb = new Database(options.rankings ?? join(homedir(), '.aso-studio', 'keywords', 'rankings.db'), { readonly: true, fileMustExist: true });
    const adsDb = new Database(resolve(options.db ?? '../asa-ads/data/asa-ads.db'), { readonly: true, fileMustExist: true });
    const terms = (adsDb.prepare(`SELECT DISTINCT term FROM asa_keyword_popularity WHERE storefront = ?`).all(country.toUpperCase()) as Array<{ term: string }>).map((row) => row.term);
    const pairs = terms.map((term) => [signalOf(depthOnDay(hintsDb, country, dayA, term)), signalOf(depthOnDay(hintsDb, country, dayB, term))]).filter((pair): pair is [number, number] => pair[0] != null && pair[1] != null);
    const tau = kendallTau(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]));
    console.log(`Stability ${dayA} vs ${dayB}: ${pairs.length} terms with depth on both days, Kendall tau ${f(tau)} (needs >= 0.80) -> ${tau >= 0.8 ? 'PASS' : 'FAIL'}`);
    return;
  }

  const base = (options.base ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
  if (options.refresh) {
    // Second dated sample for the stability check: refetch every probe of a fixed sample today (no early stop).
    const size = Number(options.refresh) || 100;
    const sampleDb = new Database(resolve(options.db ?? '../asa-ads/data/asa-ads.db'), { readonly: true, fileMustExist: true });
    const all = sampleDb.prepare(`SELECT DISTINCT term, popularity FROM asa_keyword_popularity WHERE storefront = ? AND popularity IS NOT NULL`).all(country.toUpperCase()) as Array<{ term: string; popularity: number }>;
    const hash = (term: string) => [...term].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const pick = (list: typeof all) => list.sort((a, b) => hash(a.term) - hash(b.term)).slice(0, Math.ceil(size / 2)).map((row) => row.term);
    const sample = [...pick(all.filter((row) => row.popularity > 5)), ...pick(all.filter((row) => row.popularity <= 5))];
    const toolApps = await (await fetch(`${base}/api/apps`)).json() as Array<{ id: string }>;
    const deadline = Date.now() + 90 * 60_000;
    for (let i = 0; i < sample.length && Date.now() < deadline; i += 25) {
      for (;;) {
        const response = await fetch(`${base}/api/apps/${toolApps[0].id}/demand`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storefront: country, terms: sample.slice(i, i + 25), wait_ms: 50_000, refresh: true }),
        });
        if (!response.ok) throw new Error(`demand ${response.status}`);
        if ((await response.json() as { pending: number }).pending === 0) break;
        if (Date.now() > deadline) break;
      }
      console.error(`refreshed ${Math.min(i + 25, sample.length)}/${sample.length}`);
    }
    console.log(`Refreshed ${sample.length} sampled terms for today; now run with --stability=<earlier day>,<today>.`);
    return;
  }
  const adsDb = new Database(resolve(options.db ?? '../asa-ads/data/asa-ads.db'), { readonly: true, fileMustExist: true });
  const rows = adsDb.prepare(
    `SELECT p.term, p.popularity, p.app_id AS appId FROM asa_keyword_popularity p
       JOIN (SELECT term, MAX(day) AS day FROM asa_keyword_popularity WHERE storefront = ? GROUP BY term) latest
         ON latest.term = p.term AND latest.day = p.day
      WHERE p.storefront = ? AND p.popularity IS NOT NULL`
  ).all(country.toUpperCase(), country.toUpperCase()) as Array<{ term: string; popularity: number; appId: number }>;

  const apps = await (await fetch(`${base}/api/apps`)).json() as Array<{ id: string; iTunesId: string }>;
  const samples: Sample[] = [];
  const byApp = new Map<string, typeof rows>();
  for (const row of rows) byApp.set(String(row.appId), [...(byApp.get(String(row.appId)) ?? []), row]);
  for (const [appleId, list] of byApp) {
    const tool = apps.find((app) => app.iTunesId === appleId);
    if (!tool) { console.error(`skip Apple app ${appleId}: not in the tool`); continue; }
    const depths = await depthsFor(base, tool.id, country, list.map((row) => row.term));
    for (const row of list) samples.push({ term: row.term, popularity: row.popularity, appId: tool.id, signal: signalOf(depths.get(row.term) ?? { status: 'pending' }) });
  }

  console.log(`\nAutocomplete depth vs Apple Ads popularity, storefront ${country.toUpperCase()}`);
  const perApp = [...new Set(samples.map((sample) => sample.appId))].map((id) => ({ id, ...report(id, samples.filter((sample) => sample.appId === id)) }));
  const all = report('all', samples);
  const trust = perApp.length > 0 && perApp.every((entry) => entry.rho >= 0.4 && entry.area >= 0.7 && entry.above >= 30);
  const reject = perApp.some((entry) => entry.rho < 0.2 || entry.area < 0.6);
  console.log(`\nVerdict on the depth signal (stability still needs a second day): ${trust ? 'TRUST' : reject ? 'REJECT' : 'MIDDLE ZONE (show bands as low confidence only)'}`);
  console.log(`Rules: trust if every app has Spearman >= 0.4, AUC >= 0.70 and at least 30 terms above 5; reject if any app has Spearman < 0.2 or AUC < 0.6. Overall Spearman ${f(all.rho)}, AUC ${f(all.area)}.`);
  console.log('Caveat: the terms are ones we track ourselves, so they are on-topic and biased toward niche phrases; depth also grows with phrase length.');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
