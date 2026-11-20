import test from 'node:test';
import assert from 'node:assert/strict';
import { available, slateOf, isLocked, resultOf, fromFeedMap, editCell, checkSave, VOID_AFTER_S } from '../apps/call/src/lib/bingoSlate.js';
import { scoreCard } from '../apps/call/src/lib/bingoCard.js';

const T = Date.UTC(2026, 9, 4, 12) / 1000; // 2026-10-04 12:00 UTC
const m = (matchId, startsAt, status = 'upcoming', bestOf = 3) => ({ matchId, startsAt, status, bestOf });
const matches = { 1: m(1, T + 3600), 2: m(2, T + 7200), 3: m(3, T - 600, 'live'), 5: m(5, T + 9000, 'upcoming', 5) };
const card = { cells: [['ot', 1], ['ace', 2], ['ot', 2], ['ace', 1]].map(([square, matchId]) => ({ square, matchId })) };

test('slateOf groups by UTC day and ignores matches with no start', () => {
  const list = [m(1, T), m(2, T + 13 * 3600), m(3, null)];
  assert.deepEqual(slateOf(list, '2026-10-04').map(x => x.matchId), [1]);
});

test('locked once started or no longer upcoming', () => {
  assert.equal(isLocked(m(1, T + 60), T), false);
  assert.equal(isLocked(m(1, T), T), true);
  assert.equal(isLocked(m(1, T + 60, 'live'), T), true);
});

test('editCell blocks locked, off-slate, duplicate and wrong-length swaps', () => {
  assert.ok(editCell(card, 0, { square: 'c4', matchId: 1 }, matches, T).card);
  assert.match(editCell(card, 0, { square: 'c4', matchId: 3 }, matches, T).error, /already started/);
  assert.match(editCell({ cells: [{ square: 'ot', matchId: 3 }, ...card.cells.slice(1)] }, 0, { square: 'c4', matchId: 1 }, matches, T).error, /locked/);
  assert.match(editCell(card, 0, { square: 'ace', matchId: 2 }, matches, T).error, /duplicate/);
  assert.match(editCell(card, 0, { square: 'map3', matchId: 5 }, matches, T).error, /does not fit/);
  assert.ok(editCell(card, 0, { square: 'map3', matchId: 1 }, matches, T).card);
});

test('checkSave only lets unlocked cells change', () => {
  assert.deepEqual(checkSave(card, card, matches, T), []);
  const lockedStored = { cells: [{ square: 'ot', matchId: 3 }, ...card.cells.slice(1)] };
  assert.deepEqual(checkSave(card, lockedStored, matches, T), ['cell 0: locked']);
});

test('map 3 only fits a Bo3: free in a Bo5, impossible in a Bo1', () => {
  assert.equal(available('map3', { bestOf: 3 }), true);
  assert.equal(available('map3', { bestOf: 5 }), false);
  assert.equal(available('map3', { bestOf: 1 }), false);
  assert.equal(available('ace', { bestOf: 5 }), true);
  const bad = { cells: [{ square: 'map3', matchId: 5 }, ...card.cells.slice(1)] };
  assert.match(checkSave(bad, null, matches, T)[0], /does not fit/);
});

test('resultOf: only rank-3 finals resolve; stale unresolved matches go void', () => {
  const map = { score: [13, 12], halves: { t1: { atk: 7, def: 6 }, t2: { atk: 6, def: 6 } },
    players: [{ k: 25, d: 10, acs: 300, fk: 3, mk: [1, 0, 0, 1], cl: [0, 0, 1, 0, 0], agent: 'jett', side: 1 }] };
  assert.equal(resultOf({ status: 'final', statsRank: 3, maps: [map], startsAt: T, firstFinalAt: T + 100 }, T + 200).state, 'final');
  assert.equal(resultOf({ status: 'final', statsRank: 4, maps: [map], startsAt: T }, T + 200).state, 'final');
  assert.equal(resultOf({ status: 'final', statsRank: 1, startsAt: T }, T + 200).state, 'pending');
  assert.equal(resultOf({ status: 'final', statsRank: 3, forfeit: true, startsAt: T }, T + 200).state, 'void');
  assert.equal(resultOf({ status: 'final', statsRank: 2, startsAt: T }, T + VOID_AFTER_S + 1).state, 'void');
  const f = fromFeedMap(map);
  assert.deepEqual([f.score1, f.t1_atk, f.players[0].mk5, f.players[0].cl3], [13, 7, 1, 1]);
});

test('end to end: a feed-shaped final scores through scoreCard', () => {
  const map = { score: [13, 12], halves: { t1: { atk: 7, def: 6 }, t2: { atk: 6, def: 6 } },
    players: [{ k: 25, d: 10, acs: 300, fk: 3, mk: [1, 0, 0, 1], cl: [0, 0, 1, 0, 0], agent: 'jett', side: 1 }] };
  const res = resultOf({ status: 'final', statsRank: 3, maps: [map], startsAt: T, firstFinalAt: T + 100 }, T + 200);
  const r = scoreCard({ cells: card.cells }, { 1: res, 2: { state: 'pending' } });
  assert.equal(r.cells[0], 'hit'); // ot @ 1
  assert.equal(r.cells[3], 'hit'); // ace @ 1
  assert.equal(r.cells[1], 'pending');
});
