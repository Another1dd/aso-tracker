import assert from 'node:assert/strict';
import test from 'node:test';
import { auc, balancedAccuracy, bestCutoff, bootstrap, kendallTau, seeded, signalOf, spearman, wordBucket } from '../cli/demand-stats.js';

test('signal: exact hits beat longer-phrase hits, never is 0, unresolved is excluded', () => {
  assert.equal(signalOf({ status: 'hit', match: 'exact', ratio: 0.4 }), 0.6);
  assert.equal(signalOf({ status: 'hit', match: 'extended', ratio: 0.4 }), 0.3);
  assert.equal(signalOf({ status: 'never' }), 0);
  assert.equal(signalOf({ status: 'pending' }), null);
  assert.equal(signalOf({ status: 'error' }), null);
});

test('AUC counts ties as half and returns NaN without both classes', () => {
  assert.equal(auc([3, 4], [1, 2]), 1);
  assert.equal(auc([1, 2], [3, 4]), 0);
  assert.equal(auc([1, 2], [1, 2]), 0.5);
  assert.ok(Number.isNaN(auc([], [1])));
});

test('Spearman and Kendall behave on known orderings', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(kendallTau([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  assert.equal(kendallTau([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])));
});

test('the bootstrap is reproducible and brackets a clear effect', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ term: `t${i}`, popularity: i < 30 ? 9 : 5, signal: i < 30 ? 0.6 + (i % 3) * 0.05 : 0.1 + (i % 4) * 0.05 }));
  const statistic = (sample: typeof rows) => auc(sample.filter((r) => r.popularity > 5).map((r) => r.signal), sample.filter((r) => r.popularity <= 5).map((r) => r.signal));
  const first = bootstrap(rows, statistic);
  assert.deepEqual(first, bootstrap(rows, statistic));
  assert.ok(first.low > 0.9 && first.high <= 1);
  assert.notEqual(seeded()(), seeded(7)());
});

test('a cutoff fitted on one set classifies another, and word buckets cap at three', () => {
  const rows = [{ term: 'a', popularity: 9, signal: 0.8 }, { term: 'b', popularity: 5, signal: 0.1 }, { term: 'c', popularity: 9, signal: 0.7 }, { term: 'd', popularity: 5, signal: 0.2 }];
  const cutoff = bestCutoff(rows);
  assert.equal(balancedAccuracy(rows, cutoff), 1);
  assert.ok(Number.isNaN(balancedAccuracy([{ term: 'x', popularity: 9, signal: 0.9 }], cutoff)));
  assert.equal(wordBucket('one'), 1);
  assert.equal(wordBucket('a b c d e'), 3);
});
