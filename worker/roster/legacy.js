import { ingestRosterRun } from './ingest.js';

// Replay the weekly game's GCD snapshots (migration 0010: roster_snapshots, roster_snapshot_rows,
// roster_source_checks) into the evidence model, for the stretch after the source's latest read.
// Those snapshots kept active players only, with no tags, roles or coaches, so every replayed read
// covers players only: it neither confirms nor closes coaches and staff. Teams match by name.
// Each unbroken stretch of identical checks becomes two reads, its first and its last, so join and
// leave windows run between real reads. Every check day still gets a timeline tick.
// tags ({ 'LEAGUE|team name lowercased': 'TAG' }) restores the team tag the game dropped, so a renamed
// team (KRU ESPORTS -> KRÜ VISA) stays one team; names without a tag fall back to name matching.
// Safe to rerun: already-replayed reads come back as duplicates.
export async function replayLegacySnapshots(db, { sourceId = 'riot-gcd', expectLeagues = [], tags = {} } = {}) {
  const since = (await db.prepare('SELECT last_success_at AS t FROM roster_sources WHERE id=?').bind(sourceId).first())?.t ?? 0;
  const checks = (await db.prepare('SELECT observed_at AS t,snapshot_id AS s FROM roster_source_checks WHERE observed_at>? ORDER BY observed_at')
    .bind(since).all()).results;
  const stretches = [];
  for (const c of checks) {
    const last = stretches.at(-1);
    if (last && last.s === c.s) last.end = c.t;
    else stretches.push({ s: c.s, start: c.t, end: c.t });
  }
  const rowsOf = new Map();
  const out = { stretches: stretches.length, runs: 0, unchanged: 0, duplicates: 0 };
  for (const st of stretches) {
    if (!rowsOf.has(st.s)) {
      rowsOf.set(st.s, (await db.prepare('SELECT player,team,league,contract_end AS contractEnd FROM roster_snapshot_rows WHERE snapshot_id=?')
        .bind(st.s).all()).results.map(r => ({ ...r, teamTag: tags[`${String(r.league).toUpperCase()}|${String(r.team).trim().toLowerCase()}`] })));
    }
    for (const t of st.start === st.end ? [st.start] : [st.start, st.end]) {
      const r = await ingestRosterRun(db, { sourceId, runKey: `legacy-${t}`, observedAt: t, rows: rowsOf.get(st.s), expectLeagues, covers: ['player'] });
      if (r.duplicate) out.duplicates++;
      else if (r.unchanged) out.unchanged++;
      else out.runs++;
    }
  }
  await db.prepare(`INSERT OR IGNORE INTO roster_read_days(source_id,day,first_at)
    SELECT ?1,observed_at/86400,MIN(observed_at) FROM roster_source_checks WHERE observed_at>?2 GROUP BY observed_at/86400`).bind(sourceId, since).run();
  return out;
}
