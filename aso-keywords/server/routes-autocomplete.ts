import type { Express } from 'express';
import { loadApps, loadKeywords, saveApps } from './config.js';
import { anchorRule, collectSoup, demandBand, ensureDepth, normalizeHint, soupJob, suggestDepth } from './autocomplete.js';
import { asaPopularity, tokenize } from './suggestions.js';

/** Topic anchors, autocomplete collection and the demand band. `:id` is validated in index.ts. */

const STOREFRONT = /^[a-z]{2}$/;

function wordLists(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(value)) {
    if (key !== '*' && !STOREFRONT.test(key)) return null;
    if (!Array.isArray(list)) return null;
    const words = list.map((word) => normalizeHint(String(word))).filter((word) => word && word.length <= 40);
    if (words.length) out[key] = [...new Set(words)].slice(0, 60);
  }
  return out;
}

export function registerAutocompleteRoutes(app: Express) {
  app.get('/api/apps/:id/anchors', (req, res) => {
    const storefront = String(req.query.storefront ?? '*').toLowerCase();
    const config = loadApps().find((item) => item.id === req.params.id);
    const tracked = new Set((loadKeywords(req.params.id)[storefront] ?? []).flatMap(tokenize));
    const rule = anchorRule(config, storefront, tracked);
    res.json({ configured: config?.anchors ?? {}, excluded: config?.excludeAnchors ?? {}, resolved: { anchors: rule.anchors, excluded: rule.excluded, defaultWords: [...rule.defaults] } });
  });

  app.put('/api/apps/:id/anchors', (req, res) => {
    const body = req.body as { anchors?: unknown; excludeAnchors?: unknown };
    const anchors = body.anchors === undefined ? undefined : wordLists(body.anchors);
    const excludeAnchors = body.excludeAnchors === undefined ? undefined : wordLists(body.excludeAnchors);
    if (anchors === null || excludeAnchors === null) { res.status(400).json({ error: 'anchors and excludeAnchors are { "us": ["word"], "*": [...] }' }); return; }
    const apps = loadApps();
    const target = apps.find((item) => item.id === req.params.id);
    if (!target) { res.status(404).json({ error: 'unknown app' }); return; }
    if (anchors !== undefined) target.anchors = anchors;
    if (excludeAnchors !== undefined) target.excludeAnchors = excludeAnchors;
    saveApps(apps);
    res.json({ ok: true, anchors: target.anchors ?? {}, excludeAnchors: target.excludeAnchors ?? {} });
  });

  app.post('/api/apps/:id/autocomplete/collect', (req, res) => {
    const storefront = String((req.body as { storefront?: string }).storefront ?? '').toLowerCase();
    if (!STOREFRONT.test(storefront)) { res.status(400).json({ error: 'storefront required' }); return; }
    const config = loadApps().find((item) => item.id === req.params.id);
    const seeds = (config?.anchors?.[storefront] ?? config?.anchors?.['*'] ?? []).map((anchor) => normalizeHint(anchor).replace(/\*/g, '')).filter((anchor) => anchor.length >= 3);
    if (!seeds.length) { res.status(400).json({ error: 'configure anchors for this storefront first (PUT /api/apps/:id/anchors)' }); return; }
    if (soupJob.running) { res.status(409).json({ error: 'a collection is already running', running: soupJob.running }); return; }
    void collectSoup(req.params.id, storefront, [...new Set(seeds)]);
    res.status(202).json({ started: seeds.length });
  });

  app.get('/api/apps/:id/autocomplete', (_req, res) => { res.json(soupJob); });

  app.post('/api/apps/:id/demand', async (req, res) => {
    const body = req.body as { storefront?: string; terms?: unknown; wait_ms?: number };
    const storefront = String(body.storefront ?? '').toLowerCase();
    const config = loadApps().find((item) => item.id === req.params.id);
    if (!config || !STOREFRONT.test(storefront)) { res.status(400).json({ error: 'known app and storefront required' }); return; }
    const terms = [...new Set((Array.isArray(body.terms) ? body.terms : []).map((term) => normalizeHint(String(term))).filter(Boolean))].slice(0, 100);
    const waitMs = Math.min(Math.max(Number(body.wait_ms) || 0, 0), 60_000);
    try {
      const [popularity] = await Promise.all([asaPopularity(config, storefront, terms, waitMs), ensureDepth(storefront, terms, waitMs)]);
      let pending = popularity?.pending ?? 0;
      const items = [];
      for (const term of terms) {
        const depth = await suggestDepth(term, storefront);
        if (depth.status === 'pending') pending++;
        const value = popularity?.values.get(term)?.popularity ?? null;
        items.push({ term, popularity: value, depth, ...demandBand(value, depth) });
      }
      res.json({ storefront, note: 'Популярность Apple Ads одна на строку для всех витрин; группы B–D — оценка по подсказкам Apple, не объём поиска.', pending, items });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}
