// Record a roster move a team has announced but Riot's contract database does not show yet.
// It appears on the team page as "Announced" and stops showing once Riot's data agrees.
//
//   node scripts/roster/announce.mjs --team PRX --join PatMen,Primmie --on 2026-11-19 --source https://x.com/...
//   node scripts/roster/announce.mjs --team T1 --roster crashies,BuZz,TenZ,iZu,stax --reported
//     (a full lineup: joins and leaves are worked out against Riot's current listing, and it replaces
//      earlier manual entries for that team and kind; --reported marks "[SOURCES]" reporting)
//   node scripts/roster/announce.mjs --team T1 --join Sacy --kind coach --on 2026-11-18
//   node scripts/roster/announce.mjs --team T1 --leave Autumn --kind coach
//   node scripts/roster/announce.mjs --list
//   node scripts/roster/announce.mjs --withdraw 3
//
// Writes to the local D1 unless --remote is given (production).
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1]; };
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function run(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'vfl-daily-scores', flag('remote') ? '--remote' : '--local',
    '--config', 'apps/call/wrangler.jsonc', '--json', '--command', sql], { encoding: 'utf8' });
  return JSON.parse(out).flatMap(r => r.results ?? []);
}

if (flag('list')) {
  console.table(run(`SELECT a.id,t.name AS team,a.move,a.handle,a.kind,a.basis,a.announced_on AS announced,a.source_url AS source,
    CASE WHEN a.withdrawn_at IS NULL THEN '' ELSE 'withdrawn' END AS state
    FROM roster_announcements a JOIN roster_teams t ON t.id=a.team_id ORDER BY a.id DESC LIMIT 50`));
  process.exit(0);
}
if (value('withdraw')) {
  run(`UPDATE roster_announcements SET withdrawn_at=unixepoch() WHERE id=${Number(value('withdraw'))}`);
  console.log(`Withdrew announcement ${Number(value('withdraw'))}.`);
  process.exit(0);
}

const team = value('team');
const kind = value('kind') ?? 'player';
const on = value('on') ?? new Date().toISOString().slice(0, 10);
const source = value('source');
const basis = flag('reported') ? 'reported' : 'announced';
const listOf = (name, move) => (value(name) ?? '').split(',').map(h => h.trim()).filter(Boolean).map(handle => ({ handle, move }));
const roster = listOf('roster');
if (!team || !(roster.length || value('join') || value('leave')) || !/^\d{4}-\d{2}-\d{2}$/.test(on)
  || !['player', 'coach', 'staff'].includes(kind) || (source && !/^https:\/\//.test(source))) {
  console.error('Usage: --team TAG (--roster a,b,c | --join a,b | --leave c) [--kind player|coach|staff] [--reported] [--on YYYY-MM-DD] [--source https://...] [--remote]');
  process.exit(1);
}

// The team by tag (or id): of teams sharing a tag, the one listed most recently.
const teamId = /^\d+$/.test(team) ? Number(team) : run(`SELECT t.id FROM roster_teams t WHERE upper(t.tag)=upper(${q(team)})
  ORDER BY (SELECT MAX(last_seen_at) FROM roster_memberships m WHERE m.team_id=t.id) DESC LIMIT 1`)[0]?.id;
if (!teamId) { console.error(`No team with tag ${team}.`); process.exit(1); }

let moves = [...listOf('join', 'join'), ...listOf('leave', 'leave')];
if (roster.length) {
  // Riot's current listing for this kind: open tenures confirmed in the last 30 days of reads.
  const current = run(`SELECT p.handle FROM roster_memberships m JOIN roster_people p ON p.id=m.person_id
    WHERE m.team_id=${teamId} AND m.kind=${q(kind)} AND m.end_before IS NULL
      AND m.last_seen_at >= (SELECT MAX(observed_at) FROM roster_reads WHERE source_id=m.source_id) - 30*86400`).map(r => r.handle);
  const has = (list, h) => list.some(x => x.toLowerCase() === h.toLowerCase());
  const wanted = roster.map(r => r.handle);
  moves = [...wanted.filter(h => !has(current, h)).map(handle => ({ handle, move: 'join' })),
    ...current.filter(h => !has(wanted, h)).map(handle => ({ handle, move: 'leave' }))];
  // A full lineup replaces earlier manual entries for this team and kind.
  run(`UPDATE roster_announcements SET withdrawn_at=unixepoch() WHERE team_id=${teamId} AND kind=${q(kind)} AND withdrawn_at IS NULL`);
  if (!moves.length) { console.log('Riot already lists exactly this lineup; nothing to add.'); process.exit(0); }
}
// Skip a move that is already recorded and still in effect.
for (const m of moves) {
  run(`INSERT INTO roster_announcements(team_id,handle,kind,move,announced_on,source_url,basis,added_at)
    SELECT ${teamId},${q(m.handle)},${q(kind)},${q(m.move)},${q(on)},${source ? q(source) : 'NULL'},${q(basis)},unixepoch()
    WHERE NOT EXISTS (SELECT 1 FROM roster_announcements WHERE team_id=${teamId} AND kind=${q(kind)} AND move=${q(m.move)}
      AND lower(handle)=lower(${q(m.handle)}) AND withdrawn_at IS NULL)`);
}
console.log(`Added (${basis}) ${moves.map(m => `${m.move} ${m.handle}`).join(', ')} for team ${team} (${flag('remote') ? 'production' : 'local'}).`);
