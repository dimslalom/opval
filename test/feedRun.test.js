import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1 } from './helpers/d1Shim.js';
import { handleFeed } from '../worker/feed/routes.js';
import { pickCandidates, runPoll, withRetry } from '../scripts/feed/run.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/feed/match-753462.v2.json', import.meta.url), 'utf8'));

// A fake world: vlrggapi answers from fixtures, and the "feed" is the real Worker handlers over SQLite.
function world() {
  const env = { DB: d1(), FEED_INGEST_TOKEN: 'secret' };
  const listing = [
    { match_id: '753462', stats_ready: true },
    { match_id: '999999', stats_ready: false },
  ];
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    if (url.hostname === 'vlr.test') {
      if (url.pathname === '/v2/events/matches') return Response.json({ data: { segments: listing } });
      if (url.pathname === '/v2/match/details') return Response.json(golden);
    }
    return handleFeed(new Request(url, init), env, url);
  };
  return { env, calls, fetchImpl };
}
const clientsOf = fetchImpl => ({
  vlr: async path => (await (await fetchImpl(`https://vlr.test${path}`)).json()).data,
  feed: {
    async known(id) {
      const res = await fetchImpl(`https://feed.test/api/feed/schedule?event=${id}`);
      return new Map((await res.json()).matches.map(m => [m.matchId, m]));
    },
    async ingest(body) {
      const res = await fetchImpl('https://feed.test/internal/ingest', {
        method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    },
  },
});

test('pickCandidates skips matches without published stats and ones already complete', () => {
  const listing = [{ match_id: '1', stats_ready: true }, { match_id: '2', stats_ready: false }, { match_id: '3', stats_ready: true }];
  const known = new Map([[3, { statsRank: 3 }]]);
  assert.deepEqual(pickCandidates(listing, known).map(r => r.match_id), ['1']);
});

test('poll end to end: vlrggapi match -> normalize -> Worker -> readable from the public API', async () => {
  const w = world();
  const summary = await runPoll({ clients: clientsOf(w.fetchImpl), events: [{ id: 2766 }], runId: 't1', log: () => {} });
  assert.equal(summary.fetched, 1);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.markupChanged, false);

  const match = await (await w.fetchImpl('https://feed.test/api/feed/matches/753462')).json();
  assert.equal(match.maps.length, 2);
  assert.equal(match.maps[0].players.length, 10);
  assert.equal(match.teams[1].tag, 'NS');
  assert.equal(match.roundId, '2766:2026-10-01');
  assert.equal(w.env.DB.sqlite.prepare('SELECT count(*) c FROM feed_player_maps').get().c, 20);
  const meta = await (await w.fetchImpl('https://feed.test/api/feed/meta')).json();
  assert.equal(meta.stale, false);
});

test('a second poll fetches nothing: the match is already complete in the feed', async () => {
  const w = world();
  await runPoll({ clients: clientsOf(w.fetchImpl), events: [{ id: 2766 }], runId: 't1', log: () => {} });
  const again = await runPoll({ clients: clientsOf(w.fetchImpl), events: [{ id: 2766 }], runId: 't2', log: () => {} });
  assert.equal(again.fetched, 0);
});

test('a later poll updates a rescheduled upcoming match in the public schedule', async () => {
  const w = world();
  const original = structuredClone(golden);
  original.data.segments[0].start_utc = '2026-10-04 05:00:00';
  const listing = [{ match_id: '753462', stats_ready: false, status: 'Upcoming', eta: '4h', team1: { name: 'LOUD' }, team2: { name: 'Global Esports' } }];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/v2/events/matches') return Response.json({ data: { segments: listing } });
    if (url.pathname === '/v2/match/details') return Response.json(original);
    return w.fetchImpl(input, init);
  };
  const clients = clientsOf(fetchImpl);
  await runPoll({ clients, events: [{ id: 2766 }], runId: 'before', log: () => {} });
  original.data.segments[0].start_utc = '2026-10-04 09:00:00';
  await runPoll({ clients, events: [{ id: 2766 }], runId: 'after', log: () => {} });
  const schedule = await (await w.fetchImpl('https://feed.test/api/feed/schedule?event=2766')).json();
  // vlr's start_utc is US Eastern wall time: 09:00 in New York in October is 13:00 UTC.
  assert.equal(schedule.matches[0].startsAt, Date.parse('2026-10-04T13:00:00Z') / 1000);
});

test('stats listed as ready but no player rows raises markupChanged', async () => {
  const w = world();
  const broken = JSON.parse(JSON.stringify(golden));
  for (const m of broken.data.segments[0].maps) m.players = { team1: [], team2: [] };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/v2/match/details') return Response.json(broken);
    return w.fetchImpl(input, init);
  };
  const summary = await runPoll({ clients: clientsOf(fetchImpl), events: [{ id: 2766 }], runId: 't3', log: () => {} });
  assert.equal(summary.markupChanged, true);
});

import { pickWindow } from '../scripts/feed/run.js';

test('pickWindow: live always, every decided upcoming match however far ahead, never TBD slots', () => {
  const row = (id, status, eta, a = 'TL', b = 'PRX') => ({ match_id: String(id), status, eta, team1: { name: a }, team2: { name: b } });
  const listing = [
    row(1, 'LIVE', ''),
    row(2, 'Upcoming', '3h 10m'),
    row(3, 'Upcoming', '6d 1h'),
    row(4, 'Upcoming', '2h', 'TBD', 'TBD'),
    row(5, 'Upcoming', '1h'),
    row(6, 'Completed', '1d'),
    row(7, 'Upcoming', '6d'),
  ];
  const known = new Map([[5, { startsAt: 123, status: 'upcoming' }], [7, { startsAt: 456, status: 'upcoming' }]]);
  // 3 is six days out and unknown: it still enters (a playoff schedule published early). 4 is TBD.
  assert.deepEqual(pickWindow(listing, known).map(p => [p.row.match_id, p.status]), [['1', 'live'], ['2', 'upcoming'], ['3', 'upcoming'], ['5', 'upcoming'], ['7', 'upcoming']]);
});

test('refetchFinal re-fetches finished matches that are already stored', () => {
  const listing = [{ match_id: '1', stats_ready: true }, { match_id: '2', stats_ready: true }];
  const known = new Map([[1, { statsRank: 3 }], [2, { statsRank: 3 }]]);
  assert.equal(pickCandidates(listing, known).length, 0);
  assert.equal(pickCandidates(listing, known, { refetchFinal: true }).length, 2);
});

test('incomplete finals are re-checked after new matches, and only during the grace period', () => {
  const now = 1_800_000_000;
  const listing = [1, 2, 3, 4].map(id => ({ match_id: String(id), stats_ready: true }));
  const known = new Map([
    [1, { status: 'final', statsRank: 2, startsAt: now - 8 * 86400 }], // incomplete and old: given up on
    [2, { status: 'final', statsRank: 2, startsAt: now - 86400 }],     // incomplete and recent: re-checked last
    [3, { status: 'upcoming', statsRank: 0, startsAt: now - 8 * 86400 }], // never had a final: always fetched
  ]);
  assert.deepEqual(pickCandidates(listing, known, { now }).map(r => r.match_id), ['3', '4', '2']);
});

test('rejected matches do not use up the limit, so later matches still get fetched', async () => {
  const w = world();
  const listing = [{ match_id: '1', stats_ready: true }, { match_id: '753462', stats_ready: true }];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/v2/events/matches') return Response.json({ data: { segments: listing } });
    if (url.pathname === '/v2/match/details' && url.searchParams.get('match_id') === '1') {
      const bad = structuredClone(golden);
      bad.data.segments[0].match_id = '1';
      bad.data.segments[0].maps[0].players.team1[0].kills = '999';
      return Response.json(bad);
    }
    return w.fetchImpl(input, init);
  };
  const summary = await runPoll({ clients: clientsOf(fetchImpl), events: [{ id: 2766 }], runId: 't4', limit: 1, log: () => {} });
  assert.deepEqual([summary.fetched, summary.rejected, summary.accepted], [2, 1, 1]);
});

test('a final whose maps vlr left blank is stored as partial with no player rows, not rejected', async () => {
  const w = world();
  const blank = structuredClone(golden);
  for (const r of [...blank.data.segments[0].maps[0].players.team1, ...blank.data.segments[0].maps[0].players.team2]) {
    Object.assign(r, { rating: '', adr: '', kast: '', hs_pct: '', fk: '', fd: '' });
  }
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/v2/match/details') return Response.json(blank);
    return w.fetchImpl(input, init);
  };
  const summary = await runPoll({ clients: clientsOf(fetchImpl), events: [{ id: 2766 }], runId: 't5', log: () => {} });
  assert.deepEqual([summary.partial, summary.rejected], [1, 0]);
  const match = await (await w.fetchImpl('https://feed.test/api/feed/matches/753462')).json();
  assert.equal(match.statsRank, 2);
  assert.equal(match.maps.length, 2);
  assert.deepEqual(match.maps.map(m => m.players.length), [0, 10]);
});

test('withRetry rides out transient network errors and 5xx, then gives up', async () => {
  const sleep = async () => {};
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return new Response('bad gateway', { status: 502 });
    return Response.json({ ok: true });
  };
  const res = await withRetry(flaky, { sleep })('https://x.test');
  assert.equal(n, 3);
  assert.deepEqual(await res.json(), { ok: true });

  let m = 0;
  const dead = async () => { m += 1; throw new TypeError('fetch failed'); };
  await assert.rejects(withRetry(dead, { attempts: 3, sleep })('https://x.test'), /fetch failed/);
  assert.equal(m, 3);

  const notFound = async () => new Response('no', { status: 404 });
  assert.equal((await withRetry(notFound, { sleep })('https://x.test')).status, 404); // 4xx is not retried
});
