import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// autocomplete.ts opens the SQLite store on import; keep tests off the real one.
process.env.ASO_STUDIO_HOME = mkdtempSync(join(tmpdir(), 'aso-autocomplete-test-'));
const { anchorProblem, anchorRule, demandBand, matchesAnchor, probesFor, alphabetSoup } = await import('./autocomplete.js');
const { assessCandidate, buildVocabulary, genericProfile, tokenize } = await import('./suggestions.js');

const rule = anchorRule(
  { id: 'x', name: 'X', emoji: '', bundle: 'x', iTunesId: '1', anchors: { us: ['menopause', 'perimenopause', 'hot flash*', 'night sweats'] }, excludeAnchors: { '*': ['prank'] } },
  'us',
  ['menopause', 'tracker'],
);

test('anchors match whole words, accent-insensitively, with a trailing wildcard', () => {
  assert.ok(matchesAnchor('menopause tracker', 'menopause'));
  assert.ok(matchesAnchor('hot flashes app', 'hot flash*'));
  assert.ok(matchesAnchor('bouffées de chaleur', 'bouffees de chaleur'));
  assert.ok(!matchesAnchor('postmenopause', 'menopause'));
  assert.ok(!matchesAnchor('night light', 'night sweats'));
});

test('configured anchors reject off-topic phrases that share a generic word', () => {
  assert.equal(anchorProblem('menopause symptom tracker', rule), null);
  assert.equal(anchorProblem('night sweats log', rule), null);
  assert.ok(anchorProblem('night light', rule));
  assert.ok(anchorProblem('blood pressure tracker', rule));
  assert.ok(anchorProblem('menopause prank', rule));
});

test('without configured anchors generic words like tracker do not qualify a phrase', () => {
  const fallback = anchorRule(undefined, 'us', ['menopause', 'tracker']);
  assert.equal(anchorProblem('menopause diary', fallback), null);
  assert.ok(anchorProblem('stock tracker', fallback));
});

test('the ideas filter rejects stray marks and off-topic phrases under the anchor rule', () => {
  const vocab = buildVocabulary([{ key: '1', title: 'Menopause Tracker', developer: 'A' }]);
  const profile = genericProfile(new Set(tokenize('menopause tracker night sweats')), rule);
  for (const phrase of ['night light', 'blood pressure tracker', 'symptom tracker ゚']) {
    assert.equal(assessCandidate(phrase, vocab, profile).ok, false, phrase);
  }
  assert.equal(assessCandidate('night sweats tracker', vocab, profile).ok, true);
  for (const phrase of ['menopause diary 3', 'menopause by', 'for menopause']) {
    assert.equal(assessCandidate(phrase, vocab, profile).ok, false, phrase);
  }
  for (const phrase of ['night sweats and menopause', 'hot flash tracker']) {
    assert.equal(assessCandidate(phrase, vocab, profile).ok, true, phrase);
  }
});

test('probes go from the shortest prefix up and stop at six', () => {
  assert.deepEqual(probesFor('menopause tracker'), ['menopause', 'menopause t', 'menopause tr']);
  const long = probesFor('hot flash tracker');
  assert.equal(long.length, 6);
  assert.equal(long[0], 'hot');
  assert.deepEqual(probesFor('hrt'), ['hrt']);
  assert.equal(alphabetSoup('menopause', 'us').length, 27);
  assert.equal(alphabetSoup('климакс', 'ru').length, 30);
});

test('band A is a fact, B to D are estimates, errors stay unknown', () => {
  assert.equal(demandBand(33, { status: 'never', probes: 3 }).band, 'A');
  assert.equal(demandBand(5, { status: 'hit', match: 'exact', chars: 9, ratio: 0.5, position: 1, total: 8, prefix: 'menopause' }).band, 'B');
  assert.equal(demandBand(5, { status: 'hit', match: 'exact', chars: 12, ratio: 0.9, position: 4, total: 8, prefix: 'x' }).band, 'C');
  assert.equal(demandBand(5, { status: 'never', probes: 3 }).band, 'D');
  assert.equal(demandBand(5, { status: 'error' }).band, 'unknown');
  assert.equal(demandBand(null, { status: 'pending' }).band, 'unknown');
});
