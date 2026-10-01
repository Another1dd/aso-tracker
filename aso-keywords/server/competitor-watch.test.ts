import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// competitor-watch.ts opens the SQLite store on import; keep tests off the real one.
process.env.ASO_STUDIO_HOME = mkdtempSync(join(tmpdir(), 'aso-watch-test-'));
const { watchWindow } = await import('./competitor-watch.js');
const { localDay } = await import('./scheduler.js');

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

test('the window opens one hour after the nightly hour and closes after four more', () => {
  const day = localDay(at(10, 4));
  assert.equal(watchWindow(at(10, 4, 30), 4, true, day).open, false);
  assert.equal(watchWindow(at(10, 5, 0), 4, true, day).open, true);
  assert.equal(watchWindow(at(10, 8, 59), 4, true, day).open, true);
  assert.equal(watchWindow(at(10, 9, 0), 4, true, day).open, false);
});

test('it needs the nightly run of the same day, and the window start is the nightly hour', () => {
  assert.equal(watchWindow(at(10, 6), 4, true, localDay(at(9, 4))).open, false);
  assert.equal(watchWindow(at(10, 6), 4, false, null).open, true);
  assert.equal(watchWindow(at(10, 6), 4, true, localDay(at(10, 4))).since, at(10, 4));
});

test('a late nightly hour wraps past midnight instead of never opening', () => {
  const eveningRun = localDay(at(10, 23));
  assert.equal(watchWindow(at(11, 0, 30), 23, true, eveningRun).open, true);
  assert.equal(watchWindow(at(11, 3, 30), 23, true, eveningRun).open, true);
  assert.equal(watchWindow(at(11, 4, 0), 23, true, eveningRun).open, false);
  assert.equal(watchWindow(at(11, 0, 30), 23, true, localDay(at(11, 12))).open, false);
});
