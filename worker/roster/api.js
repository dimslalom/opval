import { contractPrecision, presenceAt } from './temporal.js';

// Public, cacheable reads of the evidence model: GET /api/roster/v2/*.
// Every response says which sources it rests on and how fresh they are.

const reply = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': status === 200 ? 'public, max-age=60, s-maxage=300' : 'no-store' },
});
const now = () => Math.floor(Date.now() / 1000);

// Enabled sources, optionally only those behind some memberships (a team's or a person's), so
// one source's longer history never hides another's "tracked since".
async function sources(db, where = '', bind = []) {
  return (await db.prepare(`SELECT s.id,s.name,s.url,s.attribution,s.last_attempt_at AS lastAttemptAt,s.last_success_at AS lastSuccessAt,
    s.last_change_at AS lastChangeAt,s.last_error AS lastError,
    (SELECT MIN(observed_at) FROM roster_import_runs r WHERE r.source_id=s.id) AS trackedSince
    FROM roster_sources s WHERE s.enabled=1 ${where ? `AND s.id IN (SELECT source_id FROM roster_memberships WHERE ${where})` : ''}
    ORDER BY s.id`).bind(...bind).all()).results;
}

// Manual roster entries Riot's data does not show yet: a join while the person is not listed on the
// team, a leave while they still are. Once Riot's data agrees, the entry stops counting. `where`
// narrows by team.
async function pendingAnnouncements(db, where = '', bind = []) {
  return (await db.prepare(`SELECT a.id,a.team_id AS teamId,a.handle,a.kind,a.move,a.basis,a.announced_on AS announcedOn,a.source_url AS sourceUrl,
    EXISTS(SELECT 1 FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id
      WHERE m.team_id=a.team_id AND m.kind=a.kind AND m.end_before IS NULL AND lower(p.handle)=lower(a.handle)) AS listed
    FROM roster_announcements a WHERE a.withdrawn_at IS NULL ${where} ORDER BY a.announced_on DESC,a.id`).bind(...bind).all()).results
    .filter(a => (a.move === 'join') !== Boolean(a.listed))
    .map(a => ({ id: a.id, teamId: a.teamId, handle: a.handle, kind: a.kind, move: a.move, basis: a.basis, announcedOn: a.announcedOn, sourceUrl: a.sourceUrl }));
}

const latestRead = list => Math.max(0, ...list.map(s => s.lastSuccessAt ?? 0)) || now();

function readAt(url, fallback) {
  if (!url.searchParams.has('at')) return fallback;
  const at = Number(url.searchParams.get('at'));
  return Number.isSafeInteger(at) && at >= 0 ? at : null;
}

// When each team was first and last listed by a source, and whether it is still listed. first is per
// kind: a source that listed only players for a while first lists a promoted team's coach later,
// which is still the coach's first appearance, not a join. Built from rows already fetched, or from
// one grouped query, never a subquery per row (D1 bills every row a query reads).
function spansOf(rows) {
  const spans = new Map();
  for (const r of rows) {
    const team = `${r.teamId}|${r.sourceId}`;
    const s = spans.get(team) ?? { last: 0, open: false, first: {} };
    s.last = Math.max(s.last, r.last_seen_at);
    s.open ||= r.end_before == null;
    s.first[r.kind] = Math.min(s.first[r.kind] ?? Infinity, r.start_before);
    spans.set(team, s);
  }
  return spans;
}

const membership = (m, at, spans) => {
  const span = spans.get(`${m.teamId}|${m.sourceId}`);
  // Role, status and contract as of `at`: the latest changed read on or before it, or (before the
  // tenure's first read) the earliest one.
  const then = m.asOf ? JSON.parse(m.asOf) : m;
  // A team's first appearance in a source is not a wave of joins: the players were listed because
  // the team entered (e.g. promoted into the league), so when they joined the team is unknown. Likewise
  // when a team stops being listed at all, its players did not "leave": the source stopped covering it.
  const debut = m.start_before === span.first[m.kind];
  const exit = !span.open && m.end_before != null && m.last_seen_at === span.last;
  const seen = { ...m, start_after: debut ? null : m.start_after, end_before: exit ? null : m.end_before };
  const presence = presenceAt(seen, at);
  return {
    id: m.id, personId: m.personId, handle: m.handle, teamId: m.teamId, team: m.team, tag: m.tag, league: m.league,
    kind: m.kind, role: then.role, status: then.status,
    contractEnd: then.contractEnd, contractPrecision: contractPrecision(then.contractEnd), sourceId: m.sourceId,
    joined: { after: seen.start_after, by: m.start_before },
    lastSeenAt: m.last_seen_at,
    // teamExit: last listed when the team itself dropped out of the source; no leave window is known.
    left: m.end_before == null ? null : exit ? { after: m.last_seen_at, by: m.last_seen_at, teamExit: true } : { after: m.last_seen_at, by: m.end_before },
    presence: exit && at > m.last_seen_at ? 'unknown' : presence,
  };
};
// ?1 is `at`.
const MEMBERSHIP_SQL = `SELECT m.id,m.person_id AS personId,p.handle,m.team_id AS teamId,t.name AS team,t.tag,t.league,
  m.kind,m.role,m.status,m.contract_end AS contractEnd,m.start_after,m.start_before,m.last_seen_at,m.end_before,m.source_id AS sourceId,
  (SELECT json_object('role',o.role,'status',o.status,'contractEnd',o.contract_end)
    FROM roster_observations o JOIN roster_import_runs r ON r.id=o.run_id
    WHERE o.person_id=m.person_id AND o.team_id=m.team_id AND o.kind=m.kind AND r.source_id=m.source_id
    ORDER BY r.observed_at<=?1 DESC, CASE WHEN r.observed_at<=?1 THEN -r.observed_at ELSE r.observed_at END LIMIT 1) AS asOf
  FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id`;

export async function handleRosterV2(db, url) {
  const path = url.pathname;
  let match;

  if (path === '/api/roster/v2/sources/riot-gcd/archive') {
    const before = readAt(url, now() + 1);
    if (before == null) return reply({ error: 'at must be a unix time in seconds' }, 400);
    const limit = 100;
    const { results } = await db.prepare(`SELECT observed_at AS observedAt,archive_url AS url,
      row_count AS rows,pending_count AS pending FROM roster_import_runs
      WHERE source_id='riot-gcd' AND archive_url IS NOT NULL AND observed_at<? ORDER BY observed_at DESC LIMIT ?`)
      .bind(before, limit + 1).all();
    const captures = results.slice(0, limit);
    return reply({ captures, nextAt: results.length > limit ? captures.at(-1).observedAt : null });
  }

  if (path === '/api/roster/v2/teams') {
    // Every team with an open tenure is listed, but only people confirmed in the last 30 days of reads
    // are counted: a coach last seen before a long run of players-only reads is not known to be there now.
    const teams = (await db.prepare(`WITH latest AS (SELECT source_id,
        MAX(observed_at) AS anyRead, MAX(CASE WHEN covers IS NULL THEN observed_at END) AS fullRead
        FROM roster_reads GROUP BY source_id)
      SELECT t.id,t.name,t.tag,t.league,
        SUM(m.kind='player' AND m.last_seen_at >= l.anyRead) AS players,
        SUM(m.kind<>'player' AND m.last_seen_at >= l.fullRead AND m.last_seen_at >= l.anyRead - 30 * 86400) AS staff
      FROM roster_teams t JOIN roster_memberships m ON m.team_id=t.id AND m.end_before IS NULL
      JOIN latest l ON l.source_id=m.source_id
      GROUP BY t.id ORDER BY t.league,t.name`).all()).results;
    // Manual entries take priority over Riot's data in the counts.
    for (const a of await pendingAnnouncements(db)) {
      const t = teams.find(x => x.id === a.teamId);
      if (!t) continue;
      const field = a.kind === 'player' ? 'players' : 'staff';
      t[field] = Math.max(0, t[field] + (a.move === 'join' ? 1 : -1));
    }
    return reply({ generatedAt: now(), sources: await sources(db), teams });
  }

  if (path === '/api/roster/v2/graph') {
    // One row per observed player stint. Keep separate intervals for players who rejoined a team.
    const [sourceList, { results }] = await Promise.all([
      sources(db),
      db.prepare(`WITH latest AS (SELECT source_id, MAX(observed_at) AS observed_at FROM roster_reads GROUP BY source_id)
        SELECT m.id,m.person_id AS personId,p.handle,m.team_id AS teamId,t.name,t.tag,t.league,
          m.source_id AS sourceId,m.start_before AS firstSeenAt,m.last_seen_at AS lastSeenAt,
          COALESCE(m.end_before IS NULL AND m.last_seen_at >= l.observed_at, 0) AS latest,
          r.archive_url AS archiveUrl
        FROM roster_memberships m
        JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id
        JOIN roster_sources s ON s.id=m.source_id AND s.enabled=1
        JOIN roster_import_runs r ON r.id=m.first_run_id
        LEFT JOIN latest l ON l.source_id=m.source_id
        WHERE m.kind='player'
        ORDER BY m.id`).all(),
    ]);
    const players = new Map();
    const teams = new Map();
    const stints = results.map(({ personId, handle, teamId, name, tag, league, latest, ...stint }) => {
      players.set(personId, { id: personId, handle });
      teams.set(teamId, { id: teamId, name, tag, league });
      return { personId, teamId, latest: Boolean(latest), ...stint };
    });
    return reply({ generatedAt: now(), sources: sourceList, players: [...players.values()], teams: [...teams.values()], stints });
  }

  // Connections: everyone ever listed on this team, and every tracked team those people have been on,
  // one row per person, team and kind with the span the reads listed them.
  if ((match = path.match(/^\/api\/roster\/v2\/teams\/(\d+)\/graph$/))) {
    const id = Number(match[1]);
    const links = (await db.prepare(`SELECT m.person_id AS personId,p.handle,m.team_id AS teamId,t.name AS team,t.tag,t.league,m.kind,
        MIN(m.start_before) AS first,MAX(m.last_seen_at) AS last,MAX(m.end_before IS NULL) AS open
      FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id
      WHERE m.person_id IN (SELECT person_id FROM roster_memberships WHERE team_id=?1)
      GROUP BY m.person_id,m.team_id,m.kind ORDER BY m.person_id LIMIT 1000`).bind(id).all()).results;
    return reply({ generatedAt: now(), teamId: id, links: links.map(l => ({ ...l, open: Boolean(l.open) })) });
  }

  if ((match = path.match(/^\/api\/roster\/v2\/teams\/(\d+)$/))) {
    const id = Number(match[1]);
    const info = await db.prepare('SELECT id,name,tag,league FROM roster_teams WHERE id=?').bind(id).first();
    if (!info) return reply({ error: 'not found' }, 404);
    const src = await sources(db, 'team_id=?', [id]);
    // No `at`: the current roster is what the latest successful read said.
    const at = readAt(url, latestRead(src));
    if (at == null) return reply({ error: 'at must be a unix time in seconds' }, 400);
    const rows = (await db.prepare(`${MEMBERSHIP_SQL} WHERE m.team_id=?2 ORDER BY m.start_before,p.handle LIMIT 500`).bind(at, id).all()).results;
    // One tick per day with a read (the first read that day), for the timeline.
    const reads = src.length ? (await db.prepare(`SELECT first_at AS t FROM roster_read_days WHERE source_id IN (SELECT value FROM json_each(?))
      ORDER BY day DESC LIMIT 2000`).bind(JSON.stringify(src.map(s => s.id))).all()).results.map(r => r.t).reverse() : [];
    const spans = spansOf(rows);
    const announced = await pendingAnnouncements(db, 'AND a.team_id=?', [id]);
    return reply({ generatedAt: now(), at, latestRead: latestRead(src), sources: src, team: info, reads, announced, memberships: rows.map(m => membership(m, at, spans)) });
  }

  // Person search for the sandbox: handles starting with (then containing) the query, each with
  // where Riot's data lists them now (an open tenure confirmed in the last 30 days of reads).
  if (path === '/api/roster/v2/people') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 40);
    if (q.length < 2) return reply({ people: [] });
    const people = (await db.prepare(`SELECT p.id,p.handle,
        (SELECT json_object('teamId',t.id,'team',t.name,'tag',t.tag,'league',t.league,'kind',m.kind,'status',m.status,'contractEnd',m.contract_end)
          FROM roster_memberships m JOIN roster_teams t ON t.id=m.team_id
          WHERE m.person_id=p.id AND m.end_before IS NULL
            AND m.last_seen_at >= (SELECT MAX(observed_at) FROM roster_reads WHERE source_id=m.source_id) - 30*86400
          ORDER BY m.last_seen_at DESC LIMIT 1) AS now
      FROM roster_people p WHERE lower(p.handle) LIKE ?1
      ORDER BY lower(p.handle) LIKE ?2 DESC, length(p.handle), p.handle LIMIT 12`).bind(`%${q}%`, `${q}%`).all()).results;
    return reply({ people: people.map(p => ({ id: p.id, handle: p.handle, now: p.now ? JSON.parse(p.now) : null })) });
  }

  if ((match = path.match(/^\/api\/roster\/v2\/people\/(\d+)$/))) {
    const id = Number(match[1]);
    const person = await db.prepare('SELECT id,handle FROM roster_people WHERE id=?').bind(id).first();
    if (!person) return reply({ error: 'not found' }, 404);
    const src = await sources(db, 'person_id=?', [id]);
    const at = latestRead(src);
    const rows = (await db.prepare(`${MEMBERSHIP_SQL} WHERE m.person_id=?2 ORDER BY m.start_before LIMIT 200`).bind(at, id).all()).results;
    // Spans need every membership of this person's teams: one grouped query over those teams.
    const teamRows = (await db.prepare(`SELECT team_id AS teamId,source_id AS sourceId,kind,MIN(start_before) AS start_before,
      MAX(last_seen_at) AS last_seen_at,MIN(CASE WHEN end_before IS NULL THEN 0 ELSE 1 END) AS closed
      FROM roster_memberships WHERE team_id IN (SELECT value FROM json_each(?)) GROUP BY team_id,source_id,kind`)
      .bind(JSON.stringify([...new Set(rows.map(r => r.teamId))])).all()).results
      .map(r => ({ ...r, end_before: r.closed ? 1 : null }));
    const spans = spansOf(teamRows);
    return reply({ generatedAt: now(), at, latestRead: at, sources: src, person, memberships: rows.map(m => membership(m, at, spans)) });
  }

  // Recent joins and departures. Only changes seen between two reads count: the first read of a
  // source, or of a team newly in it, is a baseline, and a team dropping out is not a wave of exits.
  if (path === '/api/roster/v2/changes') {
    // The spans are grouped once (one pass over memberships), not looked up per row.
    const rows = (await db.prepare(`WITH k AS (SELECT team_id,source_id,kind,MIN(start_before) AS first FROM roster_memberships GROUP BY 1,2,3),
        tm AS (SELECT team_id,source_id,MAX(last_seen_at) AS last,SUM(end_before IS NULL) AS open FROM roster_memberships GROUP BY 1,2)
      SELECT * FROM (
        SELECT 'joined' AS type,m.start_after AS after,m.start_before AS by,m.id,m.person_id AS personId,p.handle,m.team_id AS teamId,
          t.name AS team,t.league,m.kind,m.role FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id
          JOIN k ON k.team_id=m.team_id AND k.source_id=m.source_id AND k.kind=m.kind
          WHERE m.start_after IS NOT NULL AND m.start_before > k.first
        UNION ALL
        SELECT 'left',m.last_seen_at,m.end_before,m.id,m.person_id,p.handle,m.team_id,t.name,t.league,m.kind,m.role
          FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id JOIN roster_teams t ON t.id=m.team_id
          JOIN tm ON tm.team_id=m.team_id AND tm.source_id=m.source_id
          WHERE m.end_before IS NOT NULL AND (tm.open > 0 OR m.last_seen_at < tm.last))
      ORDER BY by DESC,type,handle LIMIT 40`).all()).results;
    return reply({ generatedAt: now(), sources: await sources(db), changes: rows.map(r => ({ ...r, window: { after: r.after, by: r.by } })) });
  }

  return reply({ error: 'not found' }, 404);
}
