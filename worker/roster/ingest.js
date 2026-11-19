// Conservative import of one complete source read into the evidence model (migration 0014).
// Every changed read is published in ONE D1 batch (a transaction), so readers see either the old
// projection or the new one. Nothing here touches gameplay tables.

const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ');
const lower = s => norm(s).toLocaleLowerCase('en-US');

export function kindOf(role) {
  const r = norm(role).toUpperCase();
  if (!r || ['PLAYER', 'ACTIVE PLAYER', 'RESERVE PLAYER'].includes(r)) return 'player';
  return r.includes('COACH') ? 'coach' : 'staff';
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

// Only these fields are kept. GCD rows also carry legal names, residency and team contact
// details; they are dropped here and never stored.
function clean(raw) {
  const league = norm(raw.league).toUpperCase();
  const team = norm(raw.team);
  const tag = norm(raw.teamTag).toUpperCase() || null;
  const handle = norm(raw.player ?? raw.handle);
  const role = norm(raw.role).toUpperCase() || 'PLAYER';
  return {
    league, team, tag, handle, role, kind: kindOf(role),
    status: lower(raw.status) || 'active',
    contractEnd: norm(raw.contractEnd) || null,
    teamKey: `${league}|${tag ?? team.toUpperCase()}`,
    personKey: lower(handle),
  };
}

// Split rows into accepted and pending. A handle listed under two different teams in one read
// could be two people: both rows wait as pending rather than guessing a merge.
export function classify(rawRows) {
  const pending = [];
  const byPerson = new Map();
  for (const raw of rawRows) {
    const row = clean(raw);
    if (!row.handle || !row.team || !row.league) { pending.push({ reason: 'missing handle, team or league', raw }); continue; }
    if (!byPerson.has(row.personKey)) byPerson.set(row.personKey, []);
    byPerson.get(row.personKey).push({ row, raw });
  }
  const accepted = [];
  const pendingPeople = new Set();
  for (const [personKey, list] of byPerson) {
    if (new Set(list.map(x => x.row.teamKey)).size > 1) {
      pendingPeople.add(personKey);
      for (const x of list) pending.push({ reason: 'same handle on more than one team', raw: x.raw });
      continue;
    }
    const seen = new Set();
    for (const { row } of list) if (!seen.has(row.kind)) { seen.add(row.kind); accepted.push(row); }
  }
  return { accepted, pending, pendingPeople };
}

const memberKey = (personKey, teamKey, kind) => `${personKey}#${teamKey}#${kind}`;

export class RosterReadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// covers: the kinds this read lists (null = all). A players-only read neither confirms nor closes
// coaches and staff, and later coach joins are timed from the last read that did list coaches.
export async function ingestRosterRun(db, { sourceId, runKey, observedAt, rows, expectLeagues = [], archiveUrl = null, covers = null }) {
  const source = await db.prepare('SELECT * FROM roster_sources WHERE id=?').bind(sourceId).first();
  if (!source?.enabled) throw new RosterReadError(`roster source ${sourceId} is not enabled`, 409);
  if (!archiveUrl) await db.prepare('UPDATE roster_sources SET last_attempt_at=? WHERE id=?').bind(observedAt, sourceId).run();
  try {
    return await importRun(db, { sourceId, runKey, observedAt, rows, expectLeagues, archiveUrl, covers });
  } catch (error) {
    if (!archiveUrl) await db.prepare('UPDATE roster_sources SET last_error=? WHERE id=?').bind(String(error.message).slice(0, 300), sourceId).run();
    throw error;
  }
}

async function importRun(db, { sourceId, runKey, observedAt, rows, expectLeagues, archiveUrl, covers }) {
  const covered = kind => !covers || covers.includes(kind);
  const coversText = covers ? covers.join(',') : null;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    throw new RosterReadError('bad roster rows');
  if (!norm(runKey)) throw new RosterReadError('runKey required');
  const state = await db.prepare(`SELECT s.last_success_at AS lastReadAt,r.id,r.observed_at,r.content_hash,
    EXISTS (SELECT 1 FROM roster_import_runs seen WHERE seen.source_id=s.id AND seen.run_key=?2) AS duplicate
    FROM roster_sources s LEFT JOIN roster_import_runs r ON r.id=(
      SELECT MAX(id) FROM roster_import_runs WHERE source_id=s.id
    ) WHERE s.id=?1`).bind(sourceId, runKey).first();
  if (state.duplicate) return { duplicate: true };
  const prevRead = state.lastReadAt ?? state.observed_at;
  if (prevRead != null && observedAt <= prevRead) throw new RosterReadError('stale read: not newer than the last successful read', 409);

  const classified = classify(rows);
  const accepted = classified.accepted.filter(r => covered(r.kind));
  const { pending, pendingPeople } = classified;
  // A read missing a whole league is a partial read, not a mass departure.
  const leagueCounts = new Map();
  for (const row of accepted) leagueCounts.set(row.league, (leagueCounts.get(row.league) ?? 0) + 1);
  const missing = expectLeagues.filter(league => !leagueCounts.has(league));
  if (missing.length) throw new RosterReadError(`incomplete read: no rows for ${missing.join(', ')}`);
  if (!accepted.length) throw new RosterReadError('no accepted roster rows');
  if (archiveUrl && [...leagueCounts].some(([league, count]) => count < 10 || !['AMERICAS', 'CN', 'EMEA', 'PACIFIC'].includes(league)))
    throw new RosterReadError('incomplete historical league or unrecognized league');

  // Team identity across rows with and without a tag: a name-only row is the team already known by
  // that name in its league; a tagged row for a team known only by name re-keys it to the tag.
  const knownTeamRows = (await db.prepare(`SELECT x.external_key AS key,t.league,t.name,
      (SELECT MAX(m.last_seen_at) FROM roster_memberships m WHERE m.team_id=t.id) AS lastSeen
    FROM roster_external_ids x JOIN roster_teams t ON t.id=x.entity_id WHERE x.source_id=? AND x.kind='team'`).bind(sourceId).all()).results;
  // Two teams can share a name when the source changed or dropped a tag (GENG then GEN): a name-only
  // row belongs to the one listed most recently.
  const teamByName = new Map();
  const newest = new Map();
  for (const t of knownTeamRows) {
    const name = `${t.league}|${lower(t.name)}`;
    if (!teamByName.has(name) || (t.lastSeen ?? 0) > newest.get(name)) { teamByName.set(name, t.key); newest.set(name, t.lastSeen ?? 0); }
  }
  const knownTeamKeys = new Set(knownTeamRows.map(t => t.key));
  const rekey = new Map();
  for (const r of accepted) {
    const existing = teamByName.get(`${r.league}|${lower(r.team)}`);
    if (!existing || existing === r.teamKey) continue;
    if (!r.tag) r.teamKey = existing;
    else if (!knownTeamKeys.has(r.teamKey) && existing === `${r.league}|${r.team.toUpperCase()}`) rekey.set(existing, r.teamKey);
  }

  const canonical = JSON.stringify(accepted.map(r => [r.personKey, r.teamKey, r.kind, r.team, r.tag, r.handle, r.role, r.status, r.contractEnd]).sort());
  const hash = await sha256(canonical);
  const unchanged = state.content_hash === hash && !pending.length;

  for (const [from, to] of rekey) {
    await db.prepare("UPDATE roster_external_ids SET external_key=? WHERE source_id=? AND kind='team' AND external_key=?").bind(to, sourceId, from).run();
  }

  // Live unchanged reads only advance freshness. Archive reads also keep their own evidence.
  if (unchanged && !archiveUrl) {
    const guard = `(SELECT MAX(id) FROM roster_import_runs WHERE source_id=?2)=?3
        AND (SELECT last_success_at FROM roster_sources WHERE id=?2) IS ?4`;
    const [, , , freshness] = await db.batch([
      db.prepare(`UPDATE roster_memberships SET last_seen_at=? WHERE source_id=? AND end_before IS NULL
        AND (?5 IS NULL OR instr(','||?5||',', ','||kind||',')) AND ${guard}`).bind(observedAt, sourceId, state.id, state.lastReadAt, coversText),
      db.prepare(`INSERT OR IGNORE INTO roster_reads(source_id,observed_at,covers) SELECT ?2,?1,?5 WHERE ${guard}`)
        .bind(observedAt, sourceId, state.id, state.lastReadAt, coversText),
      db.prepare(`INSERT OR IGNORE INTO roster_read_days(source_id,day,first_at) SELECT ?2,?1/86400,?1 WHERE ${guard}`)
        .bind(observedAt, sourceId, state.id, state.lastReadAt),
      db.prepare(`UPDATE roster_sources SET last_success_at=?1,last_error=NULL WHERE id=?2 AND ${guard}`)
        .bind(observedAt, sourceId, state.id, state.lastReadAt),
    ]);
    if (!freshness.meta.changes) throw new RosterReadError('roster read superseded by another writer', 409);
    return { unchanged: true, rows: accepted.length, pending: 0 };
  }

  const ids = (await db.prepare('SELECT kind,external_key,entity_id FROM roster_external_ids WHERE source_id=?').bind(sourceId).all()).results;
  const knownTeams = new Set(ids.filter(x => x.kind === 'team').map(x => x.external_key));
  const knownPeople = new Set(ids.filter(x => x.kind === 'person').map(x => x.external_key));
  // CROSS JOIN fixes the order: open tenures first, then one index lookup each for their keys.
  const open = (await db.prepare(`SELECT m.id,m.kind,p.external_key AS personKey,t.external_key AS teamKey
    FROM roster_memberships m
    CROSS JOIN roster_external_ids p ON p.source_id=m.source_id AND p.kind='person' AND p.entity_id=m.person_id
    CROSS JOIN roster_external_ids t ON t.source_id=m.source_id AND t.kind='team' AND t.entity_id=m.team_id
    WHERE m.source_id=? AND m.end_before IS NULL`).bind(sourceId).all()).results;
  const openByKey = new Map(open.map(m => [memberKey(m.personKey, m.teamKey, m.kind), m]));

  const teams = new Map();
  for (const r of accepted) teams.set(r.teamKey, { key: r.teamKey, name: r.team, tag: r.tag, league: r.league });
  const people = new Map();
  for (const r of accepted) people.set(r.personKey, { key: r.personKey, handle: r.handle });

  const continued = [], started = [], seenKeys = new Set();
  for (const r of accepted) {
    const k = memberKey(r.personKey, r.teamKey, r.kind);
    seenKeys.add(k);
    const row = { personKey: r.personKey, teamKey: r.teamKey, kind: r.kind, role: r.role, status: r.status, contractEnd: r.contractEnd };
    if (openByKey.has(k)) continued.push({ ...row, id: openByKey.get(k).id });
    else started.push(row);
  }
  // Not seen in a complete read = left since the last one. An identity that is pending this read
  // is ambiguous, not gone, so its tenures stay open.
  const closed = open.filter(m => covered(m.kind) && !seenKeys.has(memberKey(m.personKey, m.teamKey, m.kind)) && !pendingPeople.has(m.personKey)).map(m => m.id);

  // A new tenure was absent at the last read that listed its kind.
  const prevByKind = {};
  for (const kind of new Set(started.map(r => r.kind))) {
    // Newest first: stops at the first read covering this kind instead of scanning every read.
    prevByKind[kind] = (await db.prepare(`SELECT observed_at AS t FROM roster_reads WHERE source_id=?
      AND (covers IS NULL OR instr(','||covers||',', ','||?||',')) ORDER BY observed_at DESC LIMIT 1`).bind(sourceId, kind).first())?.t ?? null;
  }
  for (const r of started) r.after = prevByKind[r.kind];

  const origin = key => `${sourceId}:${key}`;
  const runId = `(SELECT id FROM roster_import_runs WHERE source_id=?1 AND run_key=?2)`;
  const personId = `(SELECT entity_id FROM roster_external_ids WHERE source_id=?1 AND kind='person' AND external_key=json_extract(value,'$.personKey'))`;
  const teamId = `(SELECT entity_id FROM roster_external_ids WHERE source_id=?1 AND kind='team' AND external_key=json_extract(value,'$.teamKey'))`;
  const newTeams = [...teams.values()].filter(t => !knownTeams.has(t.key)).map(t => ({ ...t, origin: origin(t.key) }));
  const newPeople = [...people.values()].filter(p => !knownPeople.has(p.key)).map(p => ({ ...p, origin: origin(p.key) }));
  const j = x => JSON.stringify(x);
  // Current names of the known entities in this read: one primary-key lookup per row.
  const namesNow = (kind, table, cols) => db.prepare(`SELECT x.external_key AS key,e.id,${cols} FROM json_each(?2) AS j
    CROSS JOIN roster_external_ids x ON x.source_id=?1 AND x.kind='${kind}' AND x.external_key=j.value
    CROSS JOIN ${table} e ON e.id=x.entity_id`);
  const teamsNow = (await namesNow('team', 'roster_teams', 'e.name,e.tag').bind(sourceId, j([...teams.keys()].filter(k => knownTeams.has(k)))).all()).results;
  const renamedTeams = teamsNow.map(r => ({ ...r, next: teams.get(r.key) }))
    .filter(r => r.name !== r.next.name || (r.next.tag && r.tag !== r.next.tag))
    .map(r => ({ id: r.id, name: r.next.name, tag: r.next.tag ?? r.tag }));
  const peopleNow = (await namesNow('person', 'roster_people', 'e.handle').bind(sourceId, j([...people.keys()].filter(k => knownPeople.has(k)))).all()).results;
  const renamedPeople = peopleNow.filter(r => r.handle !== people.get(r.key).handle).map(r => ({ id: r.id, handle: people.get(r.key).handle }));

  await db.batch([
    // UNIQUE guards a changed base. The NOT NULL check also guards a newer unchanged live read.
    db.prepare(`INSERT INTO roster_import_runs(source_id,run_key,base_run_id,observed_at,content_hash,row_count,pending_count,archive_url,covers)
      VALUES(?1,?2,?3,CASE WHEN (SELECT last_success_at FROM roster_sources WHERE id=?1) IS ?9 THEN ?4 END,?5,?6,?7,?8,?10)`)
      .bind(sourceId, runKey, state.id ?? 0, observedAt, hash, accepted.length, pending.length, archiveUrl, state.lastReadAt, coversText),
    db.prepare(`INSERT INTO roster_teams(name,tag,league,origin_key) SELECT json_extract(value,'$.name'),json_extract(value,'$.tag'),
      json_extract(value,'$.league'),json_extract(value,'$.origin') FROM json_each(?1) WHERE true`).bind(j(newTeams)),
    db.prepare(`INSERT INTO roster_external_ids(source_id,kind,external_key,entity_id) SELECT ?1,'team',json_extract(value,'$.key'),
      (SELECT id FROM roster_teams WHERE origin_key=json_extract(value,'$.origin')) FROM json_each(?2) WHERE true`).bind(sourceId, j(newTeams)),
    db.prepare(`INSERT INTO roster_people(handle,origin_key) SELECT json_extract(value,'$.handle'),json_extract(value,'$.origin')
      FROM json_each(?1) WHERE true`).bind(j(newPeople)),
    db.prepare(`INSERT INTO roster_external_ids(source_id,kind,external_key,entity_id) SELECT ?1,'person',json_extract(value,'$.key'),
      (SELECT id FROM roster_people WHERE origin_key=json_extract(value,'$.origin')) FROM json_each(?2) WHERE true`).bind(sourceId, j(newPeople)),
    // Display names follow the source (a renamed org keeps its id via its key); only renamed rows.
    db.prepare(`UPDATE roster_teams SET name=json_extract(j.value,'$.name'),tag=json_extract(j.value,'$.tag')
      FROM json_each(?1) AS j WHERE roster_teams.id=json_extract(j.value,'$.id')`).bind(j(renamedTeams)),
    db.prepare(`UPDATE roster_people SET handle=json_extract(j.value,'$.handle')
      FROM json_each(?1) AS j WHERE roster_people.id=json_extract(j.value,'$.id')`).bind(j(renamedPeople)),
    db.prepare(`INSERT INTO roster_observations(run_id,person_id,team_id,kind,role,status,contract_end)
      SELECT ${runId},${personId},${teamId},json_extract(value,'$.kind'),json_extract(value,'$.role'),json_extract(value,'$.status'),
      json_extract(value,'$.contractEnd') FROM json_each(?3) WHERE true`).bind(sourceId, runKey, j([...continued, ...started])),
    db.prepare(`INSERT INTO roster_pending(run_id,reason,raw_row) SELECT ${runId},json_extract(value,'$.reason'),json_extract(value,'$.raw')
      FROM json_each(?3) WHERE true`).bind(sourceId, runKey, j(pending.map(p => ({ reason: p.reason, raw: j(pick(p.raw)) })))),
    db.prepare(`UPDATE roster_memberships SET end_before=?1 WHERE id IN (SELECT value FROM json_each(?2))`).bind(observedAt, j(closed)),
    db.prepare(`UPDATE roster_memberships SET last_seen_at=?4,last_run_id=${runId},role=json_extract(j.value,'$.role'),
      status=json_extract(j.value,'$.status'),contract_end=json_extract(j.value,'$.contractEnd')
      FROM json_each(?3) AS j WHERE roster_memberships.id=json_extract(j.value,'$.id')`).bind(sourceId, runKey, j(continued), observedAt),
    db.prepare(`INSERT INTO roster_memberships(source_id,person_id,team_id,kind,role,status,contract_end,start_after,start_before,last_seen_at,first_run_id,last_run_id)
      SELECT ?1,${personId},${teamId},json_extract(value,'$.kind'),json_extract(value,'$.role'),json_extract(value,'$.status'),
      json_extract(value,'$.contractEnd'),json_extract(value,'$.after'),?4,?4,${runId},${runId} FROM json_each(?3) WHERE true`).bind(sourceId, runKey, j(started), observedAt),
    db.prepare(`UPDATE roster_sources SET last_success_at=?1,last_attempt_at=MAX(COALESCE(last_attempt_at,?1),?1),
      last_change_at=CASE WHEN ?3 THEN last_change_at ELSE ?1 END,last_error=NULL WHERE id=?2`)
      .bind(observedAt, sourceId, unchanged ? 1 : 0),
    db.prepare('INSERT OR IGNORE INTO roster_reads(source_id,observed_at,covers) VALUES(?,?,?)').bind(sourceId, observedAt, coversText),
    db.prepare('INSERT OR IGNORE INTO roster_read_days(source_id,day,first_at) VALUES(?1,?2/86400,?2)').bind(sourceId, observedAt),
  ]);
  return { rows: accepted.length, pending: pending.length, joined: started.length, left: closed.length, baseline: !state.id,
    ...(unchanged ? { unchanged: true } : {}) };
}

// Pending rows keep only the fields we are allowed to store.
const pick = raw => ({ league: raw.league, team: raw.team, teamTag: raw.teamTag, player: raw.player ?? raw.handle, role: raw.role, status: raw.status, contractEnd: raw.contractEnd });
