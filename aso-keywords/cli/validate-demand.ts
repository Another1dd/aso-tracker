#!/usr/bin/env tsx
// Does the autocomplete depth signal separate terms above Apple's popularity floor from terms at it,
// better than "short phrases are more popular" does? Read-only over the Ads database; the depths
// themselves are collected through a running studio (POST /demand).
//
//   npx tsx cli/validate-demand.ts [--base=http://127.0.0.1:5173] [--db=../asa-ads/data/asa-ads.db] [--country=us]
//   npx tsx cli/validate-demand.ts --refresh=100        (refetch today's hints for a fixed sample)
//   npx tsx cli/validate-demand.ts --stability=<dayA>,<dayB>   (offline, over stored hints)
//
// What this can and cannot show: every term at the floor has the same Apple value (5), so the order
// B over C over D inside the floor cannot be validated with Apple data. Only "above the floor vs at it"
// can, and only for terms we track ourselves (selection bias). Rules: docs/plans/keyword-demand-and-audit.md.
// Prints a verdict, writes nothing.
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { depthFromProbes, type ProbeRead } from '../server/autocomplete.js';
import { auc, balancedAccuracy, bestCutoff, bootstrap, kendallTau, signalOf, spearman, wordBucket, type Depth, type Row } from './demand-stats.js';

interface Sample { term: string; popularity: number; appId: string; depth: Depth }

function args() {
  const values: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const f = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : 'n/a');
const interval = (ci: { low: number; high: number }) => `[${f(ci.low)}, ${f(ci.high)}]`;

async function post(base: string, appId: string, body: object): Promise<{ items: Array<{ term: string; depth: Depth }>; pending: number }> {
  const response = await fetch(`${base}/api/apps/${appId}/demand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`demand ${response.status}`);
  return response.json() as Promise<{ items: Array<{ term: string; depth: Depth }>; pending: number }>;
}

async function depthsFor(base: string, appId: string, country: string, terms: string[]): Promise<Map<string, Depth>> {
  const out = new Map<string, Depth>();
  const deadline = Date.now() + 90 * 60_000;
  for (let i = 0; i < terms.length; i += 50) {
    const chunk = terms.slice(i, i + 50);
    while (Date.now() < deadline) {
      const data = await post(base, appId, { storefront: country, terms: chunk, wait_ms: 50_000 });
      for (const item of data.items) out.set(item.term, item.depth);
      if (data.items.every((item) => item.depth.status !== 'pending')) break;
    }
    console.error(`depth ${Math.min(i + 50, terms.length)}/${terms.length}`);
  }
  return out;
}

/** Depth of one term on one day, reading only probes that exist on BOTH days (same prefixes, same rules). */
function depthOnDay(hintsDb: Database.Database, country: string, day: string, otherDay: string, term: string): Promise<Depth> {
  const select = hintsDb.prepare(`SELECT hints_json FROM autocomplete_hints WHERE country = ? AND prefix = ? AND day = ? AND status = 'ok'`);
  const read = (prefix: string): ProbeRead => {
    const mine = select.get(country, prefix, day) as { hints_json: string } | undefined;
    const theirs = select.get(country, prefix, otherDay) as { hints_json: string } | undefined;
    return mine && theirs ? { state: 'hints', hints: JSON.parse(mine.hints_json) as string[] } : { state: 'skip' };
  };
  return depthFromProbes(term, read, { exhaustive: true });
}

function summarise(label: string, samples: Sample[]) {
  const rows: Row[] = samples.flatMap((sample) => { const signal = signalOf(sample.depth); return signal == null ? [] : [{ term: sample.term, popularity: sample.popularity, signal }]; });
  const above = rows.filter((row) => row.popularity > 5);
  const floor = rows.filter((row) => row.popularity <= 5);
  const depthAuc = (sample: Row[]) => auc(sample.filter((r) => r.popularity > 5).map((r) => r.signal), sample.filter((r) => r.popularity <= 5).map((r) => r.signal));
  const shortAuc = (sample: Row[]) => auc(sample.filter((r) => r.popularity > 5).map((r) => -r.term.length), sample.filter((r) => r.popularity <= 5).map((r) => -r.term.length));
  const lift = (sample: Row[]) => depthAuc(sample) - shortAuc(sample);
  const rho = spearman(above.map((r) => r.signal), above.map((r) => r.popularity));
  const strata = [1, 2, 3].map((bucket) => {
    const part = rows.filter((row) => wordBucket(row.term) === bucket);
    const enough = part.filter((r) => r.popularity > 5).length >= 5 && part.filter((r) => r.popularity <= 5).length >= 5;
    return { bucket, enough, auc: enough ? depthAuc(part) : NaN, n: part.length };
  });
  console.log(`\n${label}: usable ${rows.length} of ${samples.length}, above 5: ${above.length}, at the floor: ${floor.length}`);
  console.log(`  depth AUC (above vs floor) ${f(depthAuc(rows))} ${interval(bootstrap(rows, depthAuc))}`);
  console.log(`  control AUC of phrase shortness ${f(shortAuc(rows))}; lift over it ${f(lift(rows))} ${interval(bootstrap(rows, lift))}`);
  console.log(`  Spearman of depth vs popularity among terms above 5 only: ${f(rho)} ${interval(bootstrap(above, (s) => spearman(s.map((r) => r.signal), s.map((r) => r.popularity))))}`);
  console.log(`  depth AUC within word-count strata: ${strata.map((s) => `${s.bucket === 3 ? '3+' : s.bucket} words ${s.enough ? f(s.auc) : 'n/a'} (n ${s.n})`).join(', ')}`);
  return { rows, depthAuc: depthAuc(rows), liftCi: bootstrap(rows, lift), strata };
}

async function main() {
  const options = args();
  const country = (options.country ?? 'us').toLowerCase();

  if (options.stability) {
    const [dayA, dayB] = options.stability.split(',');
    const hintsDb = new Database(options.rankings ?? join(homedir(), '.aso-studio', 'keywords', 'rankings.db'), { readonly: true, fileMustExist: true });
    const adsDb = new Database(resolve(options.db ?? '../asa-ads/data/asa-ads.db'), { readonly: true, fileMustExist: true });
    const terms = (adsDb.prepare(`SELECT DISTINCT term FROM asa_keyword_popularity WHERE storefront = ?`).all(country.toUpperCase()) as Array<{ term: string }>).map((row) => row.term);
    const pairs: Array<[number, number]> = [];
    for (const term of terms) {
      const a = signalOf(await depthOnDay(hintsDb, country, dayA, dayB, term));
      const b = signalOf(await depthOnDay(hintsDb, country, dayB, dayA, term));
      if (a != null && b != null) pairs.push([a, b]);
    }
    if (pairs.length < 20) { console.log(`Stability ${dayA} vs ${dayB}: only ${pairs.length} terms have probes on both days, no verdict (run --refresh first).`); return; }
    const tau = kendallTau(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const ci = bootstrap(pairs, (sample) => kendallTau(sample.map((p) => p[0]), sample.map((p) => p[1])), 300);
    console.log(`Stability ${dayA} vs ${dayB} on the probes both days share: ${pairs.length} terms, Kendall tau ${f(tau)} ${interval(ci)} (needs >= 0.80) -> ${tau >= 0.8 ? 'PASS' : 'FAIL'}`);
    return;
  }

  const base = (options.base ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
  const adsDb = new Database(resolve(options.db ?? '../asa-ads/data/asa-ads.db'), { readonly: true, fileMustExist: true });
  // Latest value per term; a term seen by both apps is counted once.
  const rows = adsDb.prepare(
    `SELECT p.term, p.popularity, p.app_id AS appId FROM asa_keyword_popularity p
       JOIN (SELECT term, MAX(day) AS day FROM asa_keyword_popularity WHERE storefront = ? GROUP BY term) latest
         ON latest.term = p.term AND latest.day = p.day
      WHERE p.storefront = ? AND p.popularity IS NOT NULL GROUP BY p.term`
  ).all(country.toUpperCase(), country.toUpperCase()) as Array<{ term: string; popularity: number; appId: number }>;
  const apps = await (await fetch(`${base}/api/apps`)).json() as Array<{ id: string; iTunesId: string }>;

  if (options.refresh) {
    // Second dated sample for the stability check: refetch every probe of a fixed sample today (no early stop).
    const size = Number(options.refresh) || 100;
    const hash = (term: string) => [...term].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const pick = (list: typeof rows) => [...list].sort((a, b) => hash(a.term) - hash(b.term)).slice(0, Math.ceil(size / 2)).map((row) => row.term);
    const sample = [...pick(rows.filter((row) => row.popularity > 5)), ...pick(rows.filter((row) => row.popularity <= 5))];
    const deadline = Date.now() + 90 * 60_000;
    for (let i = 0; i < sample.length && Date.now() < deadline; i += 25) {
      while (Date.now() < deadline) {
        if ((await post(base, apps[0].id, { storefront: country, terms: sample.slice(i, i + 25), wait_ms: 50_000, refresh: true })).pending === 0) break;
      }
      console.error(`refreshed ${Math.min(i + 25, sample.length)}/${sample.length}`);
    }
    console.log(`Refreshed ${sample.length} sampled terms for today; now run with --stability=<earlier day>,<today>.`);
    return;
  }

  const samples: Sample[] = [];
  const byApp = new Map<string, typeof rows>();
  for (const row of rows) byApp.set(String(row.appId), [...(byApp.get(String(row.appId)) ?? []), row]);
  for (const [appleId, list] of byApp) {
    const tool = apps.find((app) => app.iTunesId === appleId);
    if (!tool) { console.error(`skip Apple app ${appleId}: not in the tool`); continue; }
    const depths = await depthsFor(base, tool.id, country, list.map((row) => row.term));
    for (const row of list) samples.push({ term: row.term, popularity: row.popularity, appId: tool.id, depth: depths.get(row.term) ?? { status: 'pending' } });
  }

  console.log(`Autocomplete depth vs Apple Ads popularity, storefront ${country.toUpperCase()}, ${samples.length} distinct terms`);
  const appIds = [...new Set(samples.map((sample) => sample.appId))];
  const perApp = appIds.map((id) => ({ id, ...summarise(id, samples.filter((sample) => sample.appId === id)) }));
  const overall = summarise('all apps', samples);

  // Leave one app out: the cutoff is chosen on the other apps only.
  console.log('\nLeave-one-app-out (cutoff on the signal fitted on the other apps, balanced accuracy on the held-out one):');
  const folds = appIds.map((held) => {
    const train = perApp.filter((entry) => entry.id !== held).flatMap((entry) => entry.rows);
    const test = perApp.find((entry) => entry.id === held)!.rows;
    const cutoff = bestCutoff(train);
    const accuracy = balancedAccuracy(test, cutoff);
    console.log(`  held out ${held}: cutoff ${f(cutoff)}, balanced accuracy ${f(accuracy)}`);
    return accuracy;
  });

  const strataOk = overall.strata.filter((s) => s.enough).every((s) => s.auc >= 0.6);
  const liftOk = overall.liftCi.low > 0;
  const foldsOk = folds.length > 1 && folds.every((accuracy) => accuracy >= 0.6);
  const reject = !(overall.liftCi.high > 0) || perApp.some((entry) => entry.depthAuc < 0.6);
  console.log('\nChecks: lift over phrase shortness has a positive 95% interval:', liftOk ? 'yes' : 'no',
    '| every word-count stratum with enough data has AUC >= 0.60:', strataOk ? 'yes' : 'no',
    '| held-out balanced accuracy >= 0.60 in every fold:', foldsOk ? 'yes' : 'no');
  console.log(`Verdict on the depth signal (stability is checked separately): ${liftOk && strataOk && foldsOk ? 'TRUST for above-vs-floor discrimination' : reject ? 'REJECT' : 'MIDDLE ZONE (low confidence only)'}`);
  console.log('Not validated by this tool, whatever the verdict: the order B > C > D inside the floor, and terms we do not track ourselves.');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
