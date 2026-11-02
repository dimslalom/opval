import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeMap, judgeMatch, validateEnvelope } from '../worker/feed/validate.js';

const player = (vlrId, side, extra = {}) => ({
  vlrId, side, handle: `p${vlrId}`, teamTag: side === 1 ? 'XLG' : 'NS', agent: 'omen',
  r2: 1.1, acs: 220, k: 18, d: 16, a: 5, kast: 72, adr: 150, hs: 25, fk: 2, fd: 2,
  mk: [3, 1, 0, 0], cl: [0, 0, 0, 0, 0], ...extra,
});
const roster = () => [1, 2, 3, 4, 5].map(i => player(i, 1)).concat([6, 7, 8, 9, 10].map(i => player(i, 2)));
const map = (score, players = roster()) => ({ gameId: 1, mapNo: 1, map: 'Summit', score, players });
const match = (maps, extra = {}) => ({ matchId: 1, eventId: 2766, status: 'final', bestOf: 3, maps, ...extra });

test('envelope rejects a schema mismatch with 409 so the job fails loudly', () => {
  assert.equal(validateEnvelope({ schemaVersion: 2, kind: 'matches', runId: 'x' }).status, 409);
  assert.equal(validateEnvelope({ schemaVersion: 1, kind: 'nope', runId: 'x' }).status, 400);
  assert.equal(validateEnvelope({ schemaVersion: 1, kind: 'matches', runId: 'x' }).ok, true);
});

test('a map with ten valid players is ok', () => {
  assert.equal(judgeMap(map([13, 11])).verdict, 'ok');
});

test('a map with no player rows is empty, not bad (stats pending)', () => {
  assert.equal(judgeMap(map([13, 11], [])).verdict, 'empty');
});

test('nine players is partial; an out-of-range stat rejects the match', () => {
  assert.equal(judgeMap(map([13, 11], roster().slice(1))).verdict, 'partial');
  assert.equal(judgeMap(map([13, 11], roster().map((p, i) => (i === 0 ? { ...p, k: 200 } : p)))).verdict, 'bad');
});

test('stats vlr left blank make a map partial; blank K/D/A or a bad neighbour still rejects', () => {
  const blanked = field => roster().map(p => ({ ...p, [field]: null }));
  for (const field of ['r2', 'adr', 'kast', 'hs', 'fk', 'fd']) assert.equal(judgeMap(map([13, 7], blanked(field))).verdict, 'partial');
  assert.equal(judgeMap(map([13, 7], blanked('k'))).verdict, 'bad');
  assert.equal(judgeMap(map([13, 7], blanked('acs'))).verdict, 'bad');
  const oneBad = blanked('adr').map((p, i) => (i === 0 ? { ...p, adr: 150, r2: 9 } : p));
  assert.equal(judgeMap(map([13, 7], oneBad)).verdict, 'bad');
  assert.equal(judgeMatch(match([map([13, 7], blanked('adr')), map([13, 9])])).statsRank, 2);
});

test('unfinished map scores are rejected', () => {
  assert.equal(judgeMap(map([12, 10])).verdict, 'bad');
  assert.equal(judgeMap(map([13, 12])).verdict, 'bad');
});

test('final match: complete -> accept rank 3; no players -> pending rank 1', () => {
  const full = match([map([13, 11]), map([13, 9])]);
  assert.deepEqual([judgeMatch(full).verdict, judgeMatch(full).statsRank], ['accept', 3]);
  const none = match([map([13, 11], []), map([13, 9], [])]);
  assert.deepEqual([judgeMatch(none).verdict, judgeMatch(none).statsRank], ['pending', 1]);
});

test('a 3-0 in a Bo3 and a too-short final are rejected', () => {
  const three = match([map([13, 1 + 10]), map([13, 9]), map([13, 8])]);
  assert.equal(judgeMatch(three).verdict, 'reject');
  assert.equal(judgeMatch(match([map([13, 11])])).verdict, 'reject');
});

test('upcoming matches carry no stats and are accepted at rank 0', () => {
  const r = judgeMatch({ matchId: 5, eventId: 2766, status: 'upcoming', maps: [] });
  assert.deepEqual([r.verdict, r.statsRank], ['accept', 0]);
});
