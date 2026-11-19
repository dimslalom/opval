import test from 'node:test';
import assert from 'node:assert/strict';
import { contractPrecision, presenceAt } from '../worker/roster/temporal.js';

// Synthetic tenures only; none of these are real roster facts.
const baseline = { start_after: null, start_before: 100, last_seen_at: 300, end_before: null };
const joinedLater = { start_after: 100, start_before: 200, last_seen_at: 300, end_before: 400 };

test('baseline tenure: nothing is claimed before tracking began', () => {
  assert.equal(presenceAt(baseline, 50), 'unknown');
  assert.equal(presenceAt(baseline, 100), 'present');
  assert.equal(presenceAt(baseline, 300), 'present');
  assert.equal(presenceAt(baseline, 301), 'possible'); // open, but after the latest read
});

test('join and leave windows stay uncertain, outside them is absent', () => {
  assert.equal(presenceAt(joinedLater, 100), 'absent');
  assert.equal(presenceAt(joinedLater, 150), 'possible');
  assert.equal(presenceAt(joinedLater, 250), 'present');
  assert.equal(presenceAt(joinedLater, 350), 'possible');
  assert.equal(presenceAt(joinedLater, 400), 'absent'); // [start, end): gone by end_before
});

test('a departure and the next tenure at the same boundary never double-count', () => {
  const first = { start_after: null, start_before: 0, last_seen_at: 100, end_before: 200 };
  const second = { start_after: 100, start_before: 200, last_seen_at: 300, end_before: null };
  assert.equal(presenceAt(first, 200), 'absent');
  assert.equal(presenceAt(second, 200), 'present');
});

test('contract end precision is kept, not widened to a day', () => {
  assert.equal(contractPrecision('2027'), 'year');
  assert.equal(contractPrecision('2027 Season End'), 'season');
  assert.equal(contractPrecision('June 30, 2027'), 'day');
  assert.equal(contractPrecision('TBD'), 'text');
  assert.equal(contractPrecision(null), null);
});
