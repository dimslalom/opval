// LOCAL ONLY. Seeds the local D1 with three made-up teams ("Demo Alpha/Bravo/Charlie", league
// DEMO) and eight weekly reads of history, so the roster UI has transfers, departures, rejoins,
// coach changes and a pending identity to show. Everything sits under its own source, labelled
// as synthetic in the UI. It never touches a remote database.
//   node scripts/dev/seed-roster-demo.mjs            seed (replaces earlier demo data)
//   node scripts/dev/seed-roster-demo.mjs --remove   remove demo data only
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ingestRosterRun } from '../../worker/roster/ingest.js';

const DIR = new URL('../../apps/call/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url);
const file = readdirSync(DIR).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
if (!file) throw new Error('No local D1 found. Run the local API once first (npm run call:api).');
const sqlite = new DatabaseSync(fileURLToPath(new URL(file, DIR)));

// The D1 surface ingestRosterRun uses.
const stmt = sql => {
  let args = [];
  const api = {
    bind: (...a) => { args = a; return api; },
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    _exec: () => sqlite.prepare(sql).run(...args),
  };
  return api;
};
const db = {
  prepare: stmt,
  batch: async list => { sqlite.exec('BEGIN'); try { const out = list.map(s => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};

const SOURCE = 'demo';
function remove() {
  sqlite.exec(`
    DELETE FROM roster_observations WHERE run_id IN (SELECT id FROM roster_import_runs WHERE source_id='${SOURCE}');
    DELETE FROM roster_pending WHERE run_id IN (SELECT id FROM roster_import_runs WHERE source_id='${SOURCE}');
    DELETE FROM roster_memberships WHERE source_id='${SOURCE}';
    DELETE FROM roster_import_runs WHERE source_id='${SOURCE}';
    DELETE FROM roster_external_ids WHERE source_id='${SOURCE}';
    DELETE FROM roster_people WHERE origin_key LIKE '${SOURCE}:%';
    DELETE FROM roster_teams WHERE origin_key LIKE '${SOURCE}:%';
    DELETE FROM roster_sources WHERE id='${SOURCE}';`);
}

remove();
if (process.argv.includes('--remove')) { console.log('Demo roster data removed.'); process.exit(0); }

sqlite.prepare(`INSERT INTO roster_sources(id,name,url,attribution,allowed_use,checked_at,enabled)
  VALUES(?,?,?,?,?,?,1)`).run(SOURCE, 'Synthetic demo teams (local only)', 'https://example.invalid/opval-demo',
  'Made-up data for local review', 'Local development only. Not real people or teams.', new Date().toISOString().slice(0, 10));

const TEAM = { A: ['Demo Alpha', 'DMA'], B: ['Demo Bravo', 'DMB'], C: ['Demo Charlie', 'DMC'] };
const p = (handle, t, extra = {}) => ({ league: 'DEMO', team: TEAM[t][0], teamTag: TEAM[t][1], player: handle, role: 'PLAYER', status: 'Active', contractEnd: '2027', ...extra });
const coach = (handle, t) => p(handle, t, { role: 'HEAD COACH', status: 'Staff' });

const r0 = [
  p('Ace', 'A', { contractEnd: '2027 Season End' }), p('Bolt', 'A'), p('Cinder', 'A'), p('Dusk', 'A'), p('Ember', 'A'), coach('Warden', 'A'),
  p('Frost', 'B'), p('Gale', 'B'), p('Haze', 'B'), p('Ion', 'B'), p('Jolt', 'B'), coach('Keel', 'B'),
  p('Kite', 'C'), p('Lumen', 'C'), p('Mist', 'C'), p('Nova', 'C'), p('Onyx', 'C'), p('Pike', 'C', { status: 'Reserve' }), coach('Quill', 'C'),
];
const without = (rows, ...h) => rows.filter(r => !h.includes(r.player));
// Week 2: Ember moves Alpha -> Bravo, Jolt leaves Bravo.
const r2 = [...without(r0, 'Ember', 'Jolt'), p('Ember', 'B')];
// Week 3: Pike promoted from reserve; Ace extends.
const r3 = [...without(r2, 'Pike', 'Ace'), p('Pike', 'C'), p('Ace', 'A', { contractEnd: '2028 Season End' })];
// Week 4: Mist listed under two teams at once: held as pending, tenure stays open.
const r4 = [...r3, p('Mist', 'A')];
// Week 5: Jolt rejoins Bravo; Alpha changes head coach.
const r5 = [...without(r3, 'Warden'), coach('Rook', 'A'), p('Jolt', 'B')];
// Week 7: Dusk moves Alpha -> Charlie, Cinder leaves.
const r7 = [...without(r5, 'Dusk', 'Cinder'), p('Dusk', 'C')];
const reads = [r0, r0, r2, r3, r4, r5, r5, r7];

const DAY = 86400;
// Weekly reads ending an hour ago.
const start = Math.floor(Date.now() / 1000) - 7 * 7 * DAY - 3600;
for (const [i, rows] of reads.entries()) {
  const out = await ingestRosterRun(db, { sourceId: SOURCE, runKey: `demo-${i}`, observedAt: start + i * 7 * DAY, rows, expectLeagues: ['DEMO'] });
  console.log(`week ${i}`, out);
}
console.log('Seeded. Remove with: node scripts/dev/seed-roster-demo.mjs --remove');
