import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1Shim.js';
import { ingestRosterRun } from '../worker/roster/ingest.js';
import { handleRosterV2 } from '../worker/roster/api.js';
import { handleFeed } from '../worker/feed/routes.js';

// Synthetic fixture teams and handles; never production facts.
const LEAGUES = ['AMERICAS', 'EMEA'];
const row = (handle, tag, extra = {}) => ({ league: tag.startsWith('E') ? 'EMEA' : 'AMERICAS', team: `Team ${tag}`, teamTag: tag, player: handle, role: 'PLAYER', status: 'Active', contractEnd: '2027', ...extra });
const base = () => [row('alpha', 'A1'), row('bravo', 'A1'), row('coach1', 'A1', { role: 'HEAD COACH', status: 'Staff' }), row('echo', 'E1')];
const run = (db, rows, runKey, observedAt) => ingestRosterRun(db, { sourceId: 'riot-gcd', runKey, observedAt, rows, expectLeagues: LEAGUES });
const members = async db => (await db.prepare(`SELECT p.handle,t.tag,m.kind,m.start_after,m.start_before,m.last_seen_at,m.end_before
  FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id ORDER BY m.id`).all()).results;
const get = async (db, path) => (await handleRosterV2(db, new URL(`https://x.test${path}`))).json();

test('baseline, unchanged read, transfer, departure and rejoin', async () => {
  const db = d1();
  assert.equal((await run(db, base(), 'r1', 100)).baseline, true);
  let m = await members(db);
  assert.equal(m.length, 4);
  assert.equal(m.find(x => x.handle === 'coach1').kind, 'coach');
  assert.ok(m.every(x => x.start_after === null && x.start_before === 100));

  assert.equal((await run(db, base(), 'r2', 200)).unchanged, true);
  assert.ok((await members(db)).every(x => x.last_seen_at === 200));
  // The unchanged read made no run, but it is still recorded as a read (timeline ticks).
  assert.deepEqual((await db.prepare("SELECT observed_at FROM roster_reads WHERE source_id='riot-gcd' ORDER BY 1").all()).results.map(r => r.observed_at), [100, 200]);

  // bravo moves to E1; alpha leaves.
  const moved = [row('bravo', 'E1'), row('coach1', 'A1', { role: 'HEAD COACH', status: 'Staff' }), row('echo', 'E1'), row('delta', 'A1')];
  const r3 = await run(db, moved, 'r3', 300);
  assert.deepEqual([r3.joined, r3.left], [2, 2]);
  m = await members(db);
  const alpha = m.find(x => x.handle === 'alpha');
  assert.deepEqual([alpha.last_seen_at, alpha.end_before], [200, 300]);
  const bravoNew = m.find(x => x.handle === 'bravo' && x.tag === 'E1');
  assert.deepEqual([bravoNew.start_after, bravoNew.start_before], [200, 300]);

  // alpha rejoins: a second tenure, the first stays closed.
  await run(db, [...moved, row('alpha', 'A1')], 'r4', 400);
  m = await members(db);
  assert.equal(m.filter(x => x.handle === 'alpha').length, 2);

  const teams = await get(db, '/api/roster/v2/teams');
  const a1 = teams.teams.find(t => t.tag === 'A1');
  assert.deepEqual([a1.players, a1.staff], [2, 1]);
  assert.equal(teams.sources[0].trackedSince, 100);
  const detail = await get(db, `/api/roster/v2/teams/${a1.id}?at=250`);
  const at250 = Object.fromEntries(detail.memberships.map(x => [`${x.handle}:${x.joined.by}`, x.presence]));
  assert.equal(at250['alpha:100'], 'possible'); // left somewhere in (200, 300]
  assert.equal(at250['bravo:100'], 'possible');
  assert.equal(at250['delta:300'], 'possible');
  assert.equal(at250['alpha:400'], 'absent');
  assert.equal((await get(db, `/api/roster/v2/teams/${a1.id}?at=50`)).memberships.find(x => x.handle === 'coach1').presence, 'unknown');
});

test('partial, stale, replayed and racing reads never publish', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  await assert.rejects(run(db, base().filter(r => r.league !== 'EMEA'), 'r2', 200), /incomplete read: no rows for EMEA/);
  assert.equal((await members(db)).filter(x => x.end_before).length, 0); // no mass departure
  const src = await db.prepare("SELECT last_attempt_at,last_success_at,last_error FROM roster_sources WHERE id='riot-gcd'").first();
  assert.deepEqual([src.last_attempt_at, src.last_success_at], [200, 100]);
  assert.match(src.last_error, /incomplete/);

  await assert.rejects(run(db, [...base(), row('late', 'A1')], 'old', 50), /stale read/);
  assert.equal((await run(db, base(), 'r1', 300)).duplicate, true);

  // Another writer publishes from the same base between our read and our batch: our batch hits
  // UNIQUE(source_id, base_run_id) and rolls back whole.
  const batch = db.batch;
  db.batch = async list => {
    db.batch = batch;
    await db.prepare("INSERT INTO roster_import_runs(source_id,run_key,base_run_id,observed_at,content_hash,row_count,pending_count) VALUES('riot-gcd','rival',1,350,'h',0,0)").run();
    return batch(list);
  };
  const before = (await members(db)).length;
  await assert.rejects(run(db, [...base(), row('foxtrot', 'E1')], 'r5', 400));
  assert.equal((await members(db)).length, before); // rolled back whole
});

test('ambiguous identities wait as pending and keep existing tenures open', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  const r = await run(db, [...base().filter(x => x.player !== 'echo'), row('golf', 'E1'), row('echo', 'E1'), row('echo', 'A1'), { league: 'EMEA', team: 'Team E1' }], 'r2', 200);
  assert.equal(r.pending, 3);
  assert.equal((await members(db)).find(x => x.handle === 'echo').end_before, null);
  const pending = (await db.prepare('SELECT raw_row FROM roster_pending').all()).results.map(x => x.raw_row).join();
  assert.doesNotMatch(pending, /contact|first|family/i);
});

test('disabled source is refused', async () => {
  const db = d1();
  await db.prepare("UPDATE roster_sources SET enabled=0 WHERE id='riot-gcd'").run();
  await assert.rejects(run(db, base(), 'r1', 100), /not enabled/);
});

test('GCD ingest feeds the evidence model while the weekly game still sees only active players', async () => {
  const env = { DB: d1(), FEED_INGEST_TOKEN: 'secret' };
  const contracts = ['AMERICAS', 'CN', 'EMEA', 'PACIFIC'].flatMap(league => [
    { league, team: `T-${league}`, teamTag: league.slice(0, 2), player: `p-${league}`, role: 'PLAYER', status: 'Active', contractEnd: '2027' },
    { league, team: `T-${league}`, teamTag: league.slice(0, 2), player: `c-${league}`, role: 'HEAD COACH', status: 'Staff', contractEnd: '2027' },
    { league, team: `T-${league}`, teamTag: league.slice(0, 2), player: `r-${league}`, role: 'PLAYER', status: 'Reserve', contractEnd: '2027' },
  ]);
  const url = new URL('https://x.test/internal/ingest');
  const res = await handleFeed(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, kind: 'contracts', runId: 'gh-1', source: { name: 'riot-gcd' }, contracts }) }), env, url);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.rows, 4); // legacy: active players only
  assert.equal(body.evidence.rows, 12);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM roster_contracts').first()).n, 4);
});

test('role, status and contract are read as of the date; person and changes endpoints', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  await run(db, [...base().filter(r => r.player !== 'alpha'), row('alpha', 'A1', { contractEnd: '2028', status: 'Reserve' })], 'r2', 200);
  await run(db, [...base().filter(r => r.player !== 'alpha'), row('alpha', 'E1')], 'r3', 300);
  const a1 = (await get(db, '/api/roster/v2/teams')).teams.find(t => t.tag === 'A1').id;
  const alphaAt = async at => (await get(db, `/api/roster/v2/teams/${a1}?at=${at}`)).memberships.find(m => m.handle === 'alpha');
  assert.deepEqual([(await alphaAt(150)).contractEnd, (await alphaAt(150)).status], ['2027', 'active']);
  assert.deepEqual([(await alphaAt(250)).contractEnd, (await alphaAt(250)).status], ['2028', 'reserve']);
  assert.equal((await alphaAt(50)).contractEnd, '2027'); // before tracking: earliest read, not the latest

  const personId = (await alphaAt(150)).personId;
  const person = await get(db, `/api/roster/v2/people/${personId}`);
  assert.deepEqual(person.memberships.map(m => [m.tag, m.left ? 'closed' : 'open']), [['A1', 'closed'], ['E1', 'open']]);

  const changes = (await get(db, '/api/roster/v2/changes')).changes;
  assert.deepEqual(changes.map(c => [c.type, c.handle]), [['joined', 'alpha'], ['left', 'alpha']]); // the baseline is not a wave of joins
  assert.deepEqual(changes[0].window, { after: 200, by: 300 });
});

test('Wayback replay records each exact read and hands history off to the live feed', async () => {
  const db = d1();
  const env = { DB: db, FEED_INGEST_TOKEN: 'secret' };
  const url = new URL('https://x.test/internal/ingest');
  const post = (kind, runId, contracts, captureTimestamp, token = 'secret') =>
    handleFeed(new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: 1, kind, runId, contracts, captureTimestamp }) }), env, url);
  const archive = (timestamp, contracts, token) => post('contracts-archive', `wayback-${timestamp}`, contracts, timestamp, token);
  const early = ['AMERICAS', 'EMEA', 'PACIFIC'].flatMap(league => Array.from({ length: 12 }, (_, i) =>
    row(`${league}-${i}`, league, { league, ...(i === 0 ? { role: 'RESERVE PLAYER', status: 'Reserve' } : {}) })));
  const china = Array.from({ length: 12 }, (_, i) => row(`CN-${i}`, 'CN', { league: 'CN' }));
  const next = [...early.slice(1), ...china];
  const first = '20221114190655';
  const second = '20230301090000';
  const third = '20240501113418';
  const at = timestamp => Date.parse(timestamp) / 1000;

  assert.equal((await archive(first, early, 'wrong')).status, 401);
  assert.equal((await archive('20221131090655', early)).status, 400);
  assert.equal((await (await archive(first, early)).json()).baseline, true);
  assert.equal((await (await archive(second, early)).json()).unchanged, true);
  assert.equal((await db.prepare('SELECT last_change_at AS t FROM roster_sources').first()).t, at('2022-11-14T19:06:55Z'));
  assert.equal((await archive(third, early)).status, 400);
  assert.equal((await (await archive(third, next)).json()).left, 1);
  assert.deepEqual(await (await archive(second, early)).json(), { duplicate: true });
  assert.equal((await archive('20230401090000', early)).status, 409);

  const retired = (await members(db)).find(member => member.handle === 'AMERICAS-0');
  assert.equal(retired.kind, 'player');
  assert.deepEqual([retired.last_seen_at, retired.end_before], [at('2023-03-01T09:00:00Z'), at('2024-05-01T11:34:18Z')]);
  const { captures } = await get(db, '/api/roster/v2/sources/riot-gcd/archive');
  assert.deepEqual(captures.map(c => c.rows), [47, 36, 36]);
  assert.ok(captures[1].url.startsWith(`https://web.archive.org/web/${second}/https://docs.google.com/`));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_contracts').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_events').first()).n, 0);

  const live = await (await post('contracts', 'live-1', next)).json();
  assert.equal(live.evidence.unchanged, true);
  assert.equal((await archive('20240601113418', next)).status, 409);
  assert.equal((await get(db, '/api/roster/v2/sources/riot-gcd/archive')).captures.length, 3);
});

test('a team entering or leaving the source is not a wave of joins or departures', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  // E2 enters the source (promoted); later the whole A1 team stops being listed.
  await run(db, [...base(), row('golf', 'E2'), row('hotel', 'E2')], 'r2', 200);
  await run(db, [row('echo', 'E1'), row('golf', 'E2'), row('hotel', 'E2'), row('india', 'E2'), row('kilo', 'A3')], 'r3', 300);
  const teams = (await get(db, '/api/roster/v2/teams')).teams;
  const e2 = await get(db, `/api/roster/v2/teams/${teams.find(t => t.tag === 'E2').id}?at=150`);
  const golf = e2.memberships.find(m => m.handle === 'golf');
  assert.equal(golf.joined.after, null); // unknown, not "joined between 100 and 200"
  assert.equal(golf.presence, 'unknown');
  assert.deepEqual(e2.memberships.find(m => m.handle === 'india').joined, { after: 200, by: 300 }); // a real join
  const a1Id = (await db.prepare("SELECT id FROM roster_teams WHERE tag='A1'").first()).id;
  const a1 = (await get(db, `/api/roster/v2/teams/${a1Id}?at=250`)).memberships.find(m => m.handle === 'alpha');
  assert.equal(a1.left.teamExit, true);
  assert.equal(a1.presence, 'unknown');
  const changes = (await get(db, '/api/roster/v2/changes')).changes.map(c => `${c.type} ${c.handle}`);
  assert.deepEqual(changes, ['joined india']);
});

test('players-only reads leave coaches alone, and teams match by name when a read has no tags', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100); // full read: alpha, bravo, coach1 on A1; echo on E1
  const playersOnly = rows => ingestRosterRun(db, { sourceId: 'riot-gcd', runKey: `p${rows.at(-1)}`, observedAt: rows.at(-1), covers: ['player'], expectLeagues: LEAGUES,
    rows: rows.slice(0, -1).map(r => ({ league: r.league, team: r.team, player: r.player, contractEnd: r.contractEnd })) }); // no tag, role or status
  await playersOnly([row('alpha', 'A1'), row('bravo', 'A1'), row('echo', 'E1'), 200]);
  await playersOnly([row('alpha', 'A1'), row('bravo', 'A1'), row('echo', 'E1'), 300]); // unchanged
  let m = await members(db);
  assert.equal(m.length, 4); // no duplicate teams or tenures from the tagless reads
  const coach = m.find(x => x.handle === 'coach1');
  assert.deepEqual([coach.last_seen_at, coach.end_before], [100, null]); // neither confirmed nor closed
  assert.equal(m.find(x => x.handle === 'alpha').last_seen_at, 300);
  assert.equal((await db.prepare("SELECT tag FROM roster_teams WHERE name='Team A1'").first()).tag, 'A1'); // tag kept

  // The next full read: coach1 gone, coach2 new. Their windows start at the last read that listed coaches.
  await run(db, [row('alpha', 'A1'), row('bravo', 'A1'), row('coach2', 'A1', { role: 'HEAD COACH', status: 'Staff' }), row('echo', 'E1')], 'r4', 400);
  m = await members(db);
  assert.deepEqual([m.find(x => x.handle === 'coach1').end_before, m.find(x => x.handle === 'coach2').start_after], [400, 100]);
});

test('a team first seen by name only is re-keyed when a read gives its tag', async () => {
  const db = d1();
  await run(db, [...base(), { league: 'EMEA', team: 'Team New', player: 'zulu', contractEnd: '2027' }], 'r1', 100);
  await run(db, [...base(), row('zulu', 'ENW', { team: 'Team New' })], 'r2', 200);
  const m = (await members(db)).filter(x => x.handle === 'zulu');
  assert.equal(m.length, 1); // same tenure continues, no exit and re-entry
  assert.equal(m[0].last_seen_at, 200);
  assert.equal((await db.prepare("SELECT tag FROM roster_teams WHERE name='Team New'").first()).tag, 'ENW');
});

test('the game snapshots replay as players-only reads after the latest roster read', async () => {
  const { ingestContracts } = await import('../worker/feed/roster.js');
  const { replayLegacySnapshots } = await import('../worker/roster/legacy.js');
  const db = d1();
  await run(db, base(), 'r1', 100); // full read: alpha, bravo, coach1 on A1; echo on E1
  const snap = players => players.map(([p, tag]) => ({ player: p, team: `Team ${tag}`, league: tag.startsWith('E') ? 'EMEA' : 'AMERICAS', contractEnd: '2027' }));
  await ingestContracts(db, { contracts: snap([['alpha', 'A1'], ['bravo', 'A1'], ['echo', 'E1']]) }, 50); // before the read: skipped
  await ingestContracts(db, { contracts: snap([['alpha', 'A1'], ['bravo', 'A1'], ['echo', 'E1']]) }, 200);
  await ingestContracts(db, { contracts: snap([['alpha', 'A1'], ['bravo', 'A1'], ['echo', 'E1']]) }, 300);
  await ingestContracts(db, { contracts: snap([['alpha', 'A1'], ['echo', 'E1'], ['bravo', 'E1']]) }, 400);
  const out = await replayLegacySnapshots(db, { expectLeagues: LEAGUES });
  // 200 and 300 are one stretch: 200 is a run (players-only differs from the full read), 300 an
  // unchanged read that extends it; 400 is the move.
  assert.deepEqual(out, { stretches: 2, runs: 2, unchanged: 1, duplicates: 0 });
  const m = await members(db);
  const bravo = m.filter(x => x.handle === 'bravo');
  assert.deepEqual(bravo.map(x => [x.tag, x.last_seen_at, x.end_before, x.start_after]), [['A1', 300, 400, null], ['E1', 400, null, 300]]);
  assert.deepEqual(m.filter(x => x.handle === 'coach1').map(x => [x.last_seen_at, x.end_before]), [[100, null]]); // untouched
  assert.equal((await replayLegacySnapshots(db, { expectLeagues: LEAGUES })).runs, 0); // rerun: nothing new
});

test('a GCD post without roles is players-only, and name matching prefers the team listed most recently', async () => {
  const env = { DB: d1(), FEED_INGEST_TOKEN: 'secret' };
  const post = async (runId, contracts) => {
    const url = new URL('https://x.test/internal/ingest');
    return handleFeed(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, kind: 'contracts', runId, source: { name: 'riot-gcd' }, contracts }) }), env, url);
  };
  const leagues = ['AMERICAS', 'CN', 'EMEA', 'PACIFIC'];
  const full = leagues.flatMap(l => [
    { league: l, team: `T-${l}`, teamTag: l.slice(0, 2), player: `p-${l}`, role: 'PLAYER', status: 'Active', contractEnd: '2027' },
    { league: l, team: `T-${l}`, teamTag: l.slice(0, 2), player: `c-${l}`, role: 'HEAD COACH', status: 'Staff', contractEnd: '2027' }]);
  await post('gh-1', full);
  // Older duplicates of T-EMEA, as tag changes in the source leave behind: one tagless, one with an old tag.
  for (const key of ['EMEA|T-EMEA', 'EMEA|OLD']) {
    await env.DB.prepare("INSERT INTO roster_teams(name,tag,league,origin_key) VALUES('T-EMEA',NULL,'EMEA',?)").bind(`riot-gcd:${key}`).run();
    await env.DB.prepare("INSERT INTO roster_external_ids VALUES('riot-gcd','team',?,(SELECT id FROM roster_teams WHERE origin_key=?))").bind(key, `riot-gcd:${key}`).run();
  }
  // The old poller: players only, no role, status or tag.
  await new Promise(r => setTimeout(r, 1100)); // the Worker stamps reads in whole seconds
  const res = await (await post('gh-2', leagues.map(l => ({ league: l, team: `T-${l}`, player: `p-${l}`, contractEnd: '2027' })))).json();
  assert.equal(res.evidence.left, 0);
  assert.equal(res.evidence.joined, 0); // p-EMEA stays on the tagged team
  const staff = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_memberships WHERE kind='coach' AND end_before IS NULL").first();
  assert.equal(staff.n, 4); // coaches untouched
});

test('an announced move shows until Riot data agrees, then stops showing', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  const a1 = (await db.prepare("SELECT id FROM roster_teams WHERE tag='A1'").first()).id;
  for (const [handle, move, basis] of [['Delta', 'join', 'reported'], ['alpha', 'leave', 'announced'], ['bravo', 'join', 'announced']]) {
    await db.prepare("INSERT INTO roster_announcements(team_id,handle,move,basis,announced_on,added_at) VALUES(?,?,?,?,'2026-11-19',1)").bind(a1, handle, move, basis).run();
  }
  const shown = async () => (await get(db, `/api/roster/v2/teams/${a1}`)).announced.map(a => `${a.basis} ${a.move} ${a.handle}`);
  assert.deepEqual(await shown(), ['reported join Delta', 'announced leave alpha']); // bravo is already listed: nothing to announce
  // The directory counts manual entries first: alpha out, Delta in.
  assert.equal((await get(db, '/api/roster/v2/teams')).teams.find(t => t.id === a1).players, 2);
  await run(db, [...base().filter(r => r.player !== 'alpha'), row('delta', 'A1')], 'r2', 200);
  assert.deepEqual(await shown(), []); // Riot now lists delta and no longer lists alpha
});

test('person search finds handles by prefix first and says where each is listed now', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  const found = (await get(db, '/api/roster/v2/people?q=ec')).people;
  assert.deepEqual(found.map(p => p.handle), ['echo']);
  assert.equal(found[0].now.tag, 'E1');
  assert.deepEqual((await get(db, '/api/roster/v2/people?q=a')).people, []); // too short to search
});

test('a team graph links its people to every other team they were on', async () => {
  const db = d1();
  await run(db, base(), 'r1', 100);
  await run(db, [...base().filter(r => r.player !== 'bravo'), row('bravo', 'E1')], 'r2', 200); // bravo moves A1 -> E1
  const a1 = (await db.prepare("SELECT id FROM roster_teams WHERE tag='A1'").first()).id;
  const links = (await get(db, `/api/roster/v2/teams/${a1}/graph`)).links;
  const bravo = links.filter(l => l.handle === 'bravo').map(l => [l.tag, l.open]).sort();
  assert.deepEqual(bravo, [['A1', false], ['E1', true]]);
  assert.ok(!links.some(l => l.handle === 'echo')); // never on A1: not part of its graph
});
