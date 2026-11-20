import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, lines, validateCard, scoreCard } from '../apps/call/src/lib/bingoCard.js';
import { byId } from '../apps/call/src/lib/bingoSquares.js';

// Score-only squares keep the fixtures small: ot, long24 and map3 are the 'close' cluster,
// stomp8 and short20 the 'stomp' cluster.
const map = (score1, score2) => ({ score1, score2, players: [] });
const final = (maps, finalAt) => ({ state: 'final', maps, finalAt });
const cell = (square, matchId) => ({ square, matchId });
const P = id => byId[id].points;
const pending = { state: 'pending' };

test('the card is 2x2, and in a 2x2 every pair of cells is a line', () => {
  assert.equal(SIZE, 2);
  const l = lines(2).map(x => x.join());
  assert.equal(new Set(l).size, 6);
  assert.deepEqual(l.sort(), ['0,1', '0,2', '0,3', '1,2', '1,3', '2,3']);
});

test('validateCard rejects wrong size, unknown square, off-slate match, duplicates', () => {
  const ok = [cell('ot', 1), cell('ace', 1), cell('ot', 2), cell('ace', 2)];
  assert.deepEqual(validateCard({ cells: ok }, [1, 2]), []);
  assert.equal(validateCard({ cells: ok.slice(1) }, [1, 2]).length, 1);
  assert.match(validateCard({ cells: [cell('nope', 1), ...ok.slice(1)] }, [1, 2])[0], /unknown/);
  assert.match(validateCard({ cells: ok }, [1])[0], /not on the slate/);
  assert.match(validateCard({ cells: [ok[0], ok[0], ...ok.slice(2)] }, [1, 2]).join(), /duplicate/);
});

test('lines of same-match, same-cluster squares pay their best cell once', () => {
  // Match 1: 13-12 (ot + long24), 5-13, 13-11: three maps, so map3 too. All three are 'close'.
  const results = { 1: final([map(13, 12), map(5, 13), map(13, 11)], 100), 2: pending };
  const r = scoreCard({ cells: [cell('ot', 1), cell('map3', 1), cell('long24', 1), cell('ace', 2)] }, results);
  assert.deepEqual(r.cells, ['hit', 'hit', 'hit', 'pending']);
  const bonus = Math.max(P('ot'), P('map3')) + Math.max(P('ot'), P('long24')) + Math.max(P('map3'), P('long24'));
  assert.equal(r.total, P('ot') + P('map3') + P('long24') + bonus);
  assert.equal(r.lines.filter(l => l.complete).length, 3);
  assert.equal(r.firstLineAt, 100);
  assert.equal(r.blackout, 0);
});

test('different matches in a line add up; a miss breaks it; pending is not a miss', () => {
  const results = { 1: final([map(13, 12)], 50), 2: final([map(13, 4)], 80), 3: pending };
  const r = scoreCard({ cells: [cell('ot', 1), cell('stomp8', 2), cell('ot', 2), cell('ot', 3)] }, results);
  assert.deepEqual(r.cells, ['hit', 'hit', 'miss', 'pending']);
  const row0 = r.lines.find(l => l.idx.join() === '0,1');
  assert.ok(row0.complete);
  assert.equal(row0.bonus, P('ot') + P('stomp8'));
  assert.equal(r.lines.filter(l => l.complete).length, 1);
  assert.equal(r.firstLineAt, 80);
});

test('a void match is a free square: it completes lines and pays nothing, and has no clock', () => {
  const results = { 1: final([map(13, 12)], 10), 2: { state: 'void' } };
  const r = scoreCard({ cells: [cell('ot', 1), cell('long24', 1), cell('ot', 2), cell('long24', 2)] }, results);
  assert.deepEqual(r.cells, ['hit', 'hit', 'free', 'free']);
  assert.equal(r.lines.filter(l => l.complete).length, 6);
  assert.equal(r.blackout, P('ot') + P('long24'));
  // The all-free line pays nothing, so it must not set the tiebreak to time 0.
  assert.equal(r.firstLineAt, 10);
});

test('a card with no complete line has no tiebreak time', () => {
  const r = scoreCard({ cells: [cell('ot', 1), cell('ace', 2), cell('ot', 2), cell('ace', 1)] },
    { 1: final([map(13, 12)], 5), 2: pending });
  assert.equal(r.firstLineAt, null);
});

test('square tests do not throw on a map with no player rows', () => {
  const m = { score1: 13, score2: 5, players: [], t1_atk: 1, t1_def: 1, t2_atk: 1, t2_def: 1 };
  for (const sq of Object.values(byId)) if (sq.scope === 'map') assert.equal(typeof sq.test(m), 'boolean', sq.id);
});
