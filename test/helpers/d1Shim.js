import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// A tiny shim over node:sqlite that mimics the D1 surface the store uses.
export function d1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0002_feed.sql', '0003_accounts.sql', '0004_account_hardening.sql', '0005_recovery_codes.sql', '0006_bingo_cards.sql', '0007_bingo_slots.sql', '0008_call_settlements.sql', '0009_player_last_played.sql', '0010_weekly_bingo_roster_wallet.sql', '0011_rescore_settlements.sql', '0012_current_week_bingo.sql', '0013_transfer_bets.sql', '0014_roster_evidence.sql', '0015_roster_archive_evidence.sql', '0016_roster_reads.sql', '0017_roster_announcements.sql', '0018_roster_announcement_basis.sql', '0019_transfer_guess_points.sql', '0020_roster_workspaces.sql']) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  }
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
  return {
    sqlite,
    prepare: stmt,
    batch: async list => { sqlite.exec('BEGIN'); try { const out = list.map(s => ({ meta: { changes: Number(s._exec().changes) } })); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
  };
}
