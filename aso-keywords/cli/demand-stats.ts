// Pure statistics for cli/validate-demand.ts, kept apart so they can be tested.

export interface Depth { status: string; match?: string; ratio?: number }

/** Larger is more strongly suggested: exact hit 1 - ratio, a longer-phrase hit half of it, never 0, unknown excluded. */
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
  if (n < 3) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** Probability that a value from `high` beats one from `low` (ties count half). */
export function auc(high: number[], low: number[]): number {
  if (!high.length || !low.length) return NaN;
  let wins = 0;
  for (const x of high) for (const y of low) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return wins / (high.length * low.length);
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

/** Deterministic generator so a verdict can be reproduced. */
export function seeded(seed = 20261001) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile bootstrap interval of `statistic` over resampled rows. */
export function bootstrap<T>(rows: T[], statistic: (sample: T[]) => number, rounds = 600): { low: number; high: number } {
  const random = seeded();
  const values: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    const value = statistic(sample);
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  if (values.length < rounds / 2) return { low: NaN, high: NaN };
  return { low: values[Math.floor(values.length * 0.025)], high: values[Math.min(values.length - 1, Math.ceil(values.length * 0.975) - 1)] };
}

export interface Row { term: string; popularity: number; signal: number }

/** Share of the two classes classified correctly by `signal >= cutoff` ("early" predicts above the floor). */
export function balancedAccuracy(rows: Row[], cutoff: number): number {
  const above = rows.filter((row) => row.popularity > 5);
  const floor = rows.filter((row) => row.popularity <= 5);
  if (!above.length || !floor.length) return NaN;
  const sensitivity = above.filter((row) => row.signal >= cutoff).length / above.length;
  const specificity = floor.filter((row) => row.signal < cutoff).length / floor.length;
  return (sensitivity + specificity) / 2;
}

/** Cutoff on the training rows that maximises balanced accuracy there. */
export function bestCutoff(rows: Row[]): number {
  const candidates = [...new Set(rows.map((row) => row.signal))].sort((a, b) => a - b);
  let best = candidates[0] ?? 0; let bestScore = -1;
  for (const cutoff of candidates) {
    const score = balancedAccuracy(rows, cutoff);
    if (Number.isFinite(score) && score > bestScore) { bestScore = score; best = cutoff; }
  }
  return best;
}

export const wordBucket = (term: string) => Math.min(term.split(' ').length, 3);
