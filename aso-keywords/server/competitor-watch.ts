import type { Express, Request, Response } from 'express';
import { db } from './db.js';
import { assertSafeAppId, loadApps, loadKeywords } from './config.js';
import { appMeta, competitorSpyReport, startSpyCheck } from './competitor-spy.js';
import { loadScheduleState, localDay } from './scheduler.js';

// Competitor watchlist: per app, a few big competitors that get a weekly review in
// every storefront the app tracks. A review = a title/subtitle snapshot (with the
// change since last week), a check of the phrases from their public metadata, and
// the gap report (phrases they rank for and we do not, with Apple Ads popularity).
// Nothing here is app-specific: the storefronts come from each app's keyword map.
// A competitor's hidden keyword field is not observable; the evidence is its public
// name/subtitle plus the real App Store result sets we hold.

db.exec(`
  CREATE TABLE IF NOT EXISTS competitor_watch (
    app_id        TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    bundle_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    developer     TEXT,
    added_at      INTEGER NOT NULL,
    PRIMARY KEY (app_id, competitor_id)
  );
  CREATE TABLE IF NOT EXISTS competitor_watch_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id TEXT NOT NULL,
    storefront    TEXT NOT NULL,
    observed_at   INTEGER NOT NULL,
    title         TEXT,
    subtitle      TEXT,
    ratings       INTEGER,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_cw_snapshots ON competitor_watch_snapshots(competitor_id, storefront, observed_at DESC);
  CREATE TABLE IF NOT EXISTS competitor_watch_digest (
    app_id        TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    storefront    TEXT NOT NULL,
    generated_at  INTEGER NOT NULL,
    payload       TEXT NOT NULL,
    PRIMARY KEY (app_id, competitor_id, storefront)
  );
`);

const WEEK_MS = 7 * 86_400_000;
const MAX_TERMS_PER_RUN = 15;
const MAX_COMBOS_PER_DAY = 25;
const CHECK_TIMEOUT_MS = 20 * 60_000;

interface WatchRow { app_id: string; competitor_id: string; bundle_id: string; name: string; developer: string | null; added_at: number }

export interface WatchGap {
  keyword: string;
  theirRank: number | null;
  popularity: number | null;
  difficulty: number | null;
  chance: number | null;
  opportunity: number | null;
  inTheirTitle: boolean;
  inTheirSubtitle: boolean;
  isNew: boolean;
}

export interface WatchDigest {
  generatedAt: string;
  storefront: string;
  competitor: { name: string; subtitle: string | null; ratings: number | null; rating: number | null; updatedAt: string | null };
  changes: Array<{ field: 'name' | 'subtitle'; from: string | null; to: string | null }>;
  counts: { theirs: number; shared: number; ours: number };
  coverage: { checked: number; found: number };
  checkedNow: number;
  gaps: WatchGap[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const storefrontRe = /^[a-z]{2}(-[a-z]{2,4})?$/;

const storefrontsOf = (appId: string) => Object.keys(loadKeywords(appId));
const watchRows = (appId?: string) => (appId
  ? db.prepare('SELECT * FROM competitor_watch WHERE app_id = ? ORDER BY added_at').all(appId)
  : db.prepare('SELECT * FROM competitor_watch ORDER BY added_at').all()) as WatchRow[];

const digestTimes = (appId: string) => {
  const times = new Map<string, number>();
  for (const row of db.prepare('SELECT competitor_id, storefront, generated_at FROM competitor_watch_digest WHERE app_id = ?').all(appId) as Array<{ competitor_id: string; storefront: string; generated_at: number }>) {
    times.set(`${row.competitor_id}|${row.storefront}`, row.generated_at);
  }
  return times;
};

async function resolveCompetitor(appId: string, ref: string) {
  const match = ref.match(/id(\d{6,})/) ?? ref.match(/^(\d{6,})$/);
  const key = match ? match[1] : ref.trim();
  if (!key) return null;
  for (const country of new Set([...storefrontsOf(appId), 'us'].map((storefront) => storefront.split('-')[0]))) {
    const meta = await appMeta(key, country);
    if (meta?.trackId) return meta;
  }
  return null;
}

/** Waits for a spy check of our terms; never aborts someone else's job. */
async function checkTerms(storefront: string, terms: string[], isBusy: () => boolean): Promise<number> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAfter = Date.now() - 1000;
    const job = startSpyCheck(storefront, terms);
    const mine = Date.parse(job.startedAt) >= startedAfter;
    while (job.status === 'running') {
      if (mine && (isBusy() || Date.now() > deadline)) job.status = 'aborted';
      else await sleep(3000);
    }
    if (mine) return job.done;
  }
  return 0;
}

let running: { appId: string; competitorId: string; storefront: string } | null = null;
let lastError: string | null = null;

async function runCombo(appId: string, watch: WatchRow, storefront: string, isBusy: () => boolean): Promise<void> {
  running = { appId, competitorId: watch.competitor_id, storefront };
  try {
    const country = storefront.split('-')[0].toLowerCase();
    const changes: WatchDigest['changes'] = [];
    const meta = await appMeta(watch.competitor_id, country);
    if (meta) {
      const prev = db.prepare('SELECT title, subtitle FROM competitor_watch_snapshots WHERE competitor_id = ? AND storefront = ? ORDER BY observed_at DESC, id DESC LIMIT 1')
        .get(watch.competitor_id, storefront) as { title: string | null; subtitle: string | null } | undefined;
      if (prev) {
        if ((prev.title ?? '') !== meta.name) changes.push({ field: 'name', from: prev.title, to: meta.name });
        if ((prev.subtitle ?? '') !== (meta.subtitle ?? '')) changes.push({ field: 'subtitle', from: prev.subtitle, to: meta.subtitle });
      }
      db.prepare('INSERT INTO competitor_watch_snapshots (competitor_id, storefront, observed_at, title, subtitle, ratings, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(watch.competitor_id, storefront, Date.now(), meta.name, meta.subtitle, meta.ratings, meta.updatedAt);
    }

    let report = await competitorSpyReport(appId, watch.competitor_id, storefront, 10);
    const terms = report.candidates.slice(0, MAX_TERMS_PER_RUN);
    let checkedNow = 0;
    if (terms.length && !isBusy()) {
      checkedNow = await checkTerms(storefront, terms, isBusy);
      if (checkedNow) report = await competitorSpyReport(appId, watch.competitor_id, storefront, 10);
    }

    const old = db.prepare('SELECT payload FROM competitor_watch_digest WHERE app_id = ? AND competitor_id = ? AND storefront = ?')
      .get(appId, watch.competitor_id, storefront) as { payload: string } | undefined;
    const oldGaps = new Set<string>();
    if (old) for (const gap of (JSON.parse(old.payload) as WatchDigest).gaps) oldGaps.add(gap.keyword);

    const digest: WatchDigest = {
      generatedAt: new Date().toISOString(),
      storefront,
      competitor: { name: report.competitor.name, subtitle: report.competitor.subtitle, ratings: report.competitor.ratings, rating: report.competitor.rating, updatedAt: report.competitor.updatedAt },
      changes,
      counts: report.counts,
      coverage: { checked: report.coverage.checked, found: report.coverage.found },
      checkedNow,
      gaps: report.rows.filter((row) => row.gap === 'theirs').slice(0, 20).map((row) => ({
        keyword: row.keyword,
        theirRank: row.theirRank,
        popularity: row.popularity,
        difficulty: row.difficulty,
        chance: row.chance,
        opportunity: row.opportunity,
        inTheirTitle: row.inTheirTitle,
        inTheirSubtitle: row.inTheirSubtitle,
        isNew: old ? !oldGaps.has(row.keyword) : false,
      })),
    };
    db.prepare('INSERT INTO competitor_watch_digest (app_id, competitor_id, storefront, generated_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, competitor_id, storefront) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload')
      .run(appId, watch.competitor_id, storefront, Date.now(), JSON.stringify(digest));
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    running = null;
  }
}

function dueCombos(now: number) {
  const out: Array<{ appId: string; watch: WatchRow; storefront: string; last: number }> = [];
  const times = new Map<string, Map<string, number>>();
  for (const watch of watchRows()) {
    if (!loadApps().some((app) => app.id === watch.app_id)) continue;
    if (!times.has(watch.app_id)) times.set(watch.app_id, digestTimes(watch.app_id));
    for (const storefront of storefrontsOf(watch.app_id)) {
      const last = times.get(watch.app_id)!.get(`${watch.competitor_id}|${storefront}`) ?? 0;
      if (now - last >= WEEK_MS) out.push({ appId: watch.app_id, watch, storefront, last });
    }
  }
  return out.sort((a, b) => a.last - b.last);
}

async function tick(isBusy: () => boolean) {
  if (running || isBusy()) return;
  const state = loadScheduleState();
  const now = Date.now();
  const start = state.config.hour + 1;
  const hour = new Date(now).getHours();
  if (hour < start || hour >= start + 4) return;
  if (state.config.enabled && state.lastNightlyDay !== localDay(now)) return;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  let done = (db.prepare('SELECT COUNT(*) AS n FROM competitor_watch_digest WHERE generated_at >= ?').get(midnight) as { n: number }).n;
  for (const next of dueCombos(now)) {
    if (done >= MAX_COMBOS_PER_DAY || isBusy()) break;
    await runCombo(next.appId, next.watch, next.storefront, isBusy);
    done++;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Weekly review after the nightly refresh, at most MAX_COMBOS_PER_DAY reviews a night. */
export function startCompetitorWatch(deps: { isBusy: () => boolean }) {
  if (timer) return;
  timer = setInterval(() => { void tick(deps.isBusy); }, 10 * 60_000);
  timer.unref?.();
  setTimeout(() => { void tick(deps.isBusy); }, 60_000).unref?.();
}

export function registerCompetitorWatchRoutes(app: Express, deps: { isBusy: () => boolean }) {
  const appOr404 = (req: Request, res: Response) => {
    const appId = assertSafeAppId(String(req.params.id));
    if (!loadApps().some((item) => item.id === appId)) { res.status(404).json({ error: 'app not found' }); return null; }
    return appId;
  };

  app.get('/api/apps/:id/competitor-watch', (req: Request, res: Response) => {
    const appId = appOr404(req, res);
    if (!appId) return;
    const times = digestTimes(appId);
    const storefronts = storefrontsOf(appId);
    res.set('Cache-Control', 'no-store');
    res.json({
      storefronts,
      running,
      lastError,
      competitors: watchRows(appId).map((row) => ({
        competitorId: row.competitor_id,
        bundleId: row.bundle_id,
        name: row.name,
        developer: row.developer,
        addedAt: row.added_at,
        digests: Object.fromEntries(storefronts.filter((storefront) => times.has(`${row.competitor_id}|${storefront}`)).map((storefront) => [storefront, times.get(`${row.competitor_id}|${storefront}`)])),
      })),
    });
  });

  app.post('/api/apps/:id/competitor-watch', async (req: Request, res: Response) => {
    const appId = appOr404(req, res);
    if (!appId) return;
    const ref = String(req.body?.ref ?? '').trim();
    if (!ref) { res.status(400).json({ error: 'ref required (App Store URL, id or bundle id)' }); return; }
    const meta = await resolveCompetitor(appId, ref);
    if (!meta?.trackId) { res.status(404).json({ error: 'competitor not found in the App Store' }); return; }
    if (String(meta.trackId) === String(loadApps().find((item) => item.id === appId)?.iTunesId)) { res.status(400).json({ error: 'that is the app itself' }); return; }
    db.prepare('INSERT OR IGNORE INTO competitor_watch (app_id, competitor_id, bundle_id, name, developer, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(appId, String(meta.trackId), meta.bundleId, meta.name, meta.developer, Date.now());
    res.json({ competitorId: String(meta.trackId), bundleId: meta.bundleId, name: meta.name });
  });

  app.delete('/api/apps/:id/competitor-watch/:competitorId', (req: Request, res: Response) => {
    const appId = appOr404(req, res);
    if (!appId) return;
    const competitorId = String(req.params.competitorId);
    db.prepare('DELETE FROM competitor_watch WHERE app_id = ? AND competitor_id = ?').run(appId, competitorId);
    db.prepare('DELETE FROM competitor_watch_digest WHERE app_id = ? AND competitor_id = ?').run(appId, competitorId);
    res.json({ ok: true });
  });

  app.get('/api/apps/:id/competitor-watch/digest', (req: Request, res: Response) => {
    const appId = appOr404(req, res);
    if (!appId) return;
    const storefront = String(req.query.storefront ?? '').toLowerCase();
    const competitorId = String(req.query.competitorId ?? '');
    if (!storefrontRe.test(storefront) || !competitorId) { res.status(400).json({ error: 'storefront and competitorId required' }); return; }
    const row = db.prepare('SELECT generated_at, payload FROM competitor_watch_digest WHERE app_id = ? AND competitor_id = ? AND storefront = ?').get(appId, competitorId, storefront) as { generated_at: number; payload: string } | undefined;
    res.set('Cache-Control', 'no-store');
    res.json({ generatedAt: row?.generated_at ?? null, digest: row ? (JSON.parse(row.payload) as WatchDigest) : null });
  });

  /** Review now, ignoring the weekly cadence: one competitor, one storefront or all of the app's. */
  app.post('/api/apps/:id/competitor-watch/run', (req: Request, res: Response) => {
    const appId = appOr404(req, res);
    if (!appId) return;
    const competitorId = String(req.body?.competitorId ?? '');
    const watch = watchRows(appId).find((row) => row.competitor_id === competitorId);
    if (!watch) { res.status(404).json({ error: 'competitor is not on the watchlist' }); return; }
    const requested = String(req.body?.storefront ?? '').toLowerCase();
    if (requested && !storefrontRe.test(requested)) { res.status(400).json({ error: 'bad storefront' }); return; }
    if (running) { res.status(409).json({ error: 'a review is already running', running }); return; }
    if (deps.isBusy()) { res.status(409).json({ error: 'a rank refresh is running; try again after it ends' }); return; }
    const storefronts = requested ? [requested] : storefrontsOf(appId);
    void (async () => { for (const storefront of storefronts) { if (deps.isBusy()) break; await runCombo(appId, watch, storefront, deps.isBusy); } })();
    res.status(202).json({ started: storefronts.length });
  });
}
