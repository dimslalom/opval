import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1Shim.js';
import { handleFeed } from '../worker/feed/routes.js';

const env = () => ({ DB: d1(), FEED_INGEST_TOKEN: 'secret' });
const call = (e, method, path, body, token = 'secret') => {
  const url = new URL(`https://x.test${path}`);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handleFeed(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, url);
};

const player = (id, side) => ({
  vlrId: id, side, handle: `p${id}`, teamTag: 'T', agent: 'omen', r2: 1, acs: 200, k: 15, d: 15, a: 4, kast: 70,
  adr: 140, hs: 20, fk: 1, fd: 1, mk: [1, 0, 0, 0], cl: [0, 0, 0, 0, 0],
});
const roster = () => [1, 2, 3, 4, 5].map(i => player(i, 1)).concat([6, 7, 8, 9, 10].map(i => player(i, 2)));
const finalMatch = () => ({
  matchId: 9, eventId: 2766, bestOf: 3, status: 'final', roundId: '2766:d1', contentHash: 'a',
  teams: [{ name: 'A', tag: 'A', score: 0 }, { name: 'B', tag: 'B', score: 2 }],
  maps: [1, 2].map(n => ({ gameId: 100 + n, mapNo: n, map: 'Lotus', score: [9, 13], players: roster() })),
});
const envelope = (extra) => ({ schemaVersion: 1, kind: 'matches', runId: 'r1', ...extra });

test('ingest without or with a wrong token is 401 and writes nothing', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/internal/ingest', envelope({ matches: [finalMatch()] }), null)).status, 401);
  assert.equal((await call(e, 'POST', '/internal/ingest', envelope({ matches: [finalMatch()] }), 'nope')).status, 401);
  assert.equal(e.DB.sqlite.prepare('SELECT count(*) c FROM feed_matches').get().c, 0);
});

test('ingest then read back: match, round and schedule endpoints agree', async () => {
  const e = env();
  const ingest = await call(e, 'POST', '/internal/ingest', envelope({ matches: [finalMatch()] }));
  assert.equal(ingest.status, 200);
  assert.deepEqual((await ingest.json()).accepted, [9]);

  const match = await (await call(e, 'GET', '/api/feed/matches/9')).json();
  assert.equal(match.maps.length, 2);
  assert.equal(match.maps[0].players.length, 10);
  assert.equal(match.statsRank, 3);

  const round = await (await call(e, 'GET', '/api/feed/rounds/2766:d1')).json();
  assert.equal(round.matches.length, 1);
  // Browsers encode the colon in round ids; the route must decode it.
  const encoded = await (await call(e, 'GET', `/api/feed/rounds/${encodeURIComponent('2766:d1')}`)).json();
  assert.equal(encoded.matches.length, 1);
  assert.equal(encoded.matches[0].maps[0].players[0].handle, 'p1');

  const schedule = await (await call(e, 'GET', '/api/feed/schedule?event=2766')).json();
  assert.equal(schedule.matches[0].matchId, 9);
});

test('meta reports staleness: no successful run yet means stale', async () => {
  const e = env();
  assert.equal((await (await call(e, 'GET', '/api/feed/meta')).json()).stale, true);
  await call(e, 'POST', '/internal/ingest', envelope({ kind: 'heartbeat' }));
  const meta = await (await call(e, 'GET', '/api/feed/meta')).json();
  assert.equal(meta.stale, false);
  assert.equal(meta.attribution, 'Data: vlr.gg');
});

test('unknown public paths 404 and non-GET public paths 405', async () => {
  const e = env();
  assert.equal((await call(e, 'GET', '/api/feed/matches/404')).status, 404);
  assert.equal((await call(e, 'POST', '/api/feed/meta', {})).status, 405);
});

test('players endpoint lists who the feed has seen, with handle and team', async () => {
  const e = env();
  await call(e, 'POST', '/internal/ingest', envelope({ matches: [finalMatch()] }));
  const body = await (await call(e, 'GET', '/api/feed/players')).json();
  assert.equal(body.players.length, 10);
  assert.ok(body.players.every(p => Number.isInteger(p.vlrId) && p.handle));
  assert.ok(!JSON.stringify(body).includes('real_name'));
});
