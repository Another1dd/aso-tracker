// Client for server/competitor-watch.ts (weekly competitor review).

export interface WatchCompetitor {
  competitorId: string;
  bundleId: string;
  name: string;
  developer: string | null;
  addedAt: number;
  /** storefront → time (ms) of the latest review */
  digests: Record<string, number>;
}

export interface WatchList {
  storefronts: string[];
  running: { appId: string; competitorId: string; storefront: string } | null;
  lastError: string | null;
  competitors: WatchCompetitor[];
}

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

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const watchApi = {
  list: (appId: string) => fetch(`/api/apps/${appId}/competitor-watch`).then((r) => json<WatchList>(r)),
  add: (appId: string, ref: string) => send('POST', `/api/apps/${appId}/competitor-watch`, { ref }).then((r) => json<{ competitorId: string; bundleId: string; name: string }>(r)),
  remove: (appId: string, competitorId: string) => send('DELETE', `/api/apps/${appId}/competitor-watch/${competitorId}`).then((r) => json<{ ok: boolean }>(r)),
  digest: (appId: string, competitorId: string, storefront: string) =>
    fetch(`/api/apps/${appId}/competitor-watch/digest?${new URLSearchParams({ competitorId, storefront })}`).then((r) => json<{ generatedAt: number | null; digest: WatchDigest | null }>(r)),
  run: (appId: string, competitorId: string, storefront?: string) =>
    send('POST', `/api/apps/${appId}/competitor-watch/run`, { competitorId, storefront }).then((r) => json<{ started: number }>(r)),
};
