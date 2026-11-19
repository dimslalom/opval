// Replay the weekly game's GCD snapshots into the roster evidence model, in a LOCAL D1 file.
// Production gets the same result by copying the replayed tables up (see docs/gcd-archive-backfill.md);
// this script never talks to a remote database.
//   node scripts/dev/replay-legacy-gcd.mjs [path/to/d1.sqlite] [tags.json]
// tags.json maps 'LEAGUE|team name lowercased' to the team's tag (from the live GCD sheet).
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { replayLegacySnapshots } from '../../worker/roster/legacy.js';

const DIR = new URL('../../apps/call/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url);
const tags = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const file = process.argv[2] || fileURLToPath(new URL(readdirSync(DIR).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite'), DIR));
const sqlite = new DatabaseSync(file);

// The D1 surface the import uses.
const stmt = sql => {
  let args = [];
  const api = {
    bind: (...a) => { args = a; return api; },
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    _exec: () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  };
  return api;
};
const db = {
  prepare: stmt,
  batch: async list => { sqlite.exec('BEGIN'); try { const out = list.map(s => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};

console.log(await replayLegacySnapshots(db, { expectLeagues: ['AMERICAS', 'CN', 'EMEA', 'PACIFIC'], tags }));
