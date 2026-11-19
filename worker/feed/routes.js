import { isAuthorized } from './auth.js';
import { ingestMatches, recordSource } from './store.js';
import { MAX_BODY_BYTES, validateEnvelope } from './validate.js';
import { ingestTransfers, ingestContracts } from './roster.js';
import { ingestRosterRun, RosterReadError } from '../roster/ingest.js';

const GCD_LEAGUES = ['AMERICAS', 'CN', 'EMEA', 'PACIFIC'];
const GCD_ARCHIVE_SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmmWiBmMMD43m5VtZq54nKlmj0ZtythsA1qCpegwx-iRptx2HEsG0T3cQlG1r2AIiKxBWnaurJZQ9Q/pubhtml';

async function postArchive(db, body, now) {
  const timestamp = body.captureTimestamp;
  if (typeof timestamp !== 'string' || !/^\d{14}$/.test(timestamp) || body.runId !== `wayback-${timestamp}`)
    return reply({ error: 'invalid Wayback capture timestamp or run ID' }, 400);
  const iso = timestamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6.000Z');
  const date = new Date(iso);
  const observedAt = date.getTime() / 1000;
  if (!Number.isFinite(observedAt) || date.toISOString() !== iso || timestamp < '20221101000000' || observedAt > now)
    return reply({ error: 'invalid Wayback capture date' }, 400);

  const expectLeagues = timestamp < '20240101000000' ? GCD_LEAGUES.filter(league => league !== 'CN') : GCD_LEAGUES;
  try {
    const result = await ingestRosterRun(db, {
      sourceId: 'riot-gcd', runKey: body.runId, observedAt, rows: body.contracts, expectLeagues,
      archiveUrl: `https://web.archive.org/web/${timestamp}/${GCD_ARCHIVE_SHEET}`,
    });
    return reply(result);
  } catch (error) {
    if (error instanceof RosterReadError) return reply({ error: error.message }, error.status);
    throw error;
  }
}

// Feed routes: POST /internal/ingest (bearer) and read-only GET /api/feed/*.
// Raw stats only. Points are computed by the client's shared scoring module,
// so a rule change never needs a re-ingest.

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function reply(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ...SECURITY },
  });
}

const PUBLIC_CACHE = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';

async function readBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    const error = new Error('payload too large');
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('invalid json');
    error.status = 400;
    throw error;
  }
}

async function postIngest(request, env) {
  if (!(await isAuthorized(request, env))) return reply({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return reply({ error: error.message }, error.status ?? 400);
  }
  const envelope = validateEnvelope(body);
  if (!envelope.ok) return reply({ error: envelope.error }, envelope.status);

  const now = Math.floor(Date.now() / 1000);
  if (body.kind === 'contracts-archive') return postArchive(env.DB, body, now);
  if (body.kind === 'matches') {
    const result = await ingestMatches(env.DB, body, now);
    await recordSource(env.DB, 'matches', { ok: true }, now);
    return reply(result);
  }
  if (body.kind === 'transfers' || body.kind === 'contracts') {
    // The evidence model (worker/roster) takes every GCD row: players, coaches, reserves. Its
    // failure is recorded on roster_sources and never blocks the legacy game path below.
    let evidence;
    if (body.kind === 'contracts') {
      try {
        // An older poller sends active players only, with no role on any row: such a read says
        // nothing about coaches and staff, so it must not close them.
        const covers = body.contracts.some(r => r && r.role != null) ? null : ['player'];
        evidence = await ingestRosterRun(env.DB, { sourceId: 'riot-gcd', runKey: body.runId, observedAt: now, rows: body.contracts, expectLeagues: GCD_LEAGUES, covers });
      } catch (error) { evidence = { error: error.message }; }
    }
    try {
      const result = body.kind === 'transfers' ? await ingestTransfers(env.DB, body, now) : await ingestContracts(env.DB, body, now);
      await recordSource(env.DB, body.kind, { ok: true }, now);
      return reply(evidence ? { ...result, evidence } : result);
    } catch (error) {
      await recordSource(env.DB, body.kind, { ok: false, error: error.message }, now);
      return reply(evidence ? { error: error.message, evidence } : { error: error.message }, 400);
    }
  }
  if (body.kind === 'heartbeat') {
    await recordSource(env.DB, 'heartbeat', { ok: true }, now);
    return reply({ ok: true });
  }
  // schedule/players/transfers/values/contracts land in later slices.
  return reply({ error: `kind ${body.kind} is not implemented yet` }, 501);
}

async function getMeta(env) {
  const { results } = await env.DB.prepare('SELECT * FROM feed_sources').all();
  const staleMinutes = Number(env.FEED_STALE_MINUTES ?? 120);
  const now = Math.floor(Date.now() / 1000);
  const sources = {};
  for (const row of results) {
    sources[row.source] = {
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
    };
  }
  const last = Math.max(0, ...results.map(r => r.last_success_at ?? 0));
  return reply({
    schemaVersion: 1,
    generatedAt: now,
    attribution: env.FEED_ATTRIBUTION ?? 'Data: vlr.gg',
    sources,
    stale: last > 0 ? now - last > staleMinutes * 60 : true,
  }, 200, PUBLIC_CACHE);
}

const matchRow = r => ({
  matchId: r.match_id, eventId: r.event_id, stage: r.stage, series: r.series, bestOf: r.best_of,
  startsAt: r.starts_at, status: r.status, statsRank: r.stats_rank, roundId: r.round_id,
  teams: [
    { id: r.team1_id, name: r.team1_name, tag: r.team1_tag, score: r.score1 },
    { id: r.team2_id, name: r.team2_name, tag: r.team2_tag, score: r.score2 },
  ],
  winner: r.winner, forfeit: !!r.forfeit, firstFinalAt: r.first_final_at,
});

async function getSchedule(env, url) {
  const event = Number(url.searchParams.get('event'));
  if (!Number.isInteger(event) || event <= 0) return reply({ error: 'event required' }, 400);
  const { results } = await env.DB
    .prepare('SELECT * FROM feed_matches WHERE event_id = ?1 ORDER BY starts_at, match_id')
    .bind(event).all();
  return reply({ event, matches: results.map(matchRow) }, 200, PUBLIC_CACHE);
}

export async function loadMatch(env, id) {
  const match = await env.DB.prepare('SELECT * FROM feed_matches WHERE match_id = ?1').bind(id).first();
  if (!match) return null;
  const maps = (await env.DB
    .prepare('SELECT * FROM feed_maps WHERE match_id = ?1 ORDER BY map_no').bind(id).all()).results;
  const rows = (await env.DB
    .prepare(`SELECT pm.*, p.handle FROM feed_player_maps pm
              LEFT JOIN feed_players p ON p.vlr_id = pm.vlr_id WHERE pm.match_id = ?1`).bind(id).all()).results;
  return {
    ...matchRow(match),
    maps: maps.map(m => ({
      gameId: m.game_id, mapNo: m.map_no, map: m.map_name, pickedBy: m.picked_by, score: [m.score1, m.score2],
      halves: { t1: { atk: m.t1_atk, def: m.t1_def }, t2: { atk: m.t2_atk, def: m.t2_def } },
      players: rows.filter(p => p.game_id === m.game_id).map(p => ({
        vlrId: p.vlr_id, handle: p.handle, side: p.side, teamTag: p.team_tag, agent: p.agent, r2: p.r2, acs: p.acs,
        k: p.k, d: p.d, a: p.a, kast: p.kast, adr: p.adr, hs: p.hs, fk: p.fk, fd: p.fd,
        mk: [p.mk2, p.mk3, p.mk4, p.mk5], cl: [p.cl1, p.cl2, p.cl3, p.cl4, p.cl5],
      })),
    })),
  };
}

// Every player the feed has seen: id, handle and current team tag. No real names, ever.
async function getPlayers(env) {
  const { results } = await env.DB
    .prepare('SELECT vlr_id, handle, country, team_tag, status, last_played_at FROM feed_players ORDER BY team_tag, handle').all();
  return reply({
    players: results.map(p => ({
      vlrId: p.vlr_id, handle: p.handle, country: p.country, teamTag: p.team_tag, status: p.status, lastPlayedAt: p.last_played_at,
    })),
  }, 200, PUBLIC_CACHE);
}

async function getMatch(env, id) {
  const match = await loadMatch(env, id);
  return match ? reply(match, 200, PUBLIC_CACHE) : reply({ error: 'not found' }, 404);
}

async function getRound(env, roundId) {
  const { results } = await env.DB
    .prepare('SELECT match_id FROM feed_matches WHERE round_id = ?1 ORDER BY starts_at').bind(roundId).all();
  const matches = [];
  for (const r of results) matches.push(await loadMatch(env, r.match_id));
  return reply({ roundId, matches }, 200, PUBLIC_CACHE);
}

export async function handleFeed(request, env, url) {
  const path = url.pathname;
  if (path === '/internal/ingest') {
    return request.method === 'POST' ? postIngest(request, env) : reply({ error: 'method not allowed' }, 405);
  }
  if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405);
  if (path === '/api/feed/meta') return getMeta(env);
  if (path === '/api/feed/schedule') return getSchedule(env, url);
  if (path === '/api/feed/players') return getPlayers(env);
  let m;
  if ((m = path.match(/^\/api\/feed\/matches\/(\d+)$/))) return getMatch(env, Number(m[1]));
  if ((m = path.match(/^\/api\/feed\/rounds\/([^/]+)$/))) return getRound(env, decodeURIComponent(m[1]));
  return reply({ error: 'not found' }, 404);
}
