-- Roster-first evidence model (docs/plans/2026-11-17-gitnexus-plan-roster-first-opval.md §6.3).
-- Additive and namespaced: the gameplay tables from 0010 (roster_contracts, roster_events, ...)
-- are untouched, and nothing here feeds bingo or transfer-bet settlement.

-- Every source the model may read, with its recorded reuse decision. An adapter whose source row
-- is missing or disabled is refused at ingest.
CREATE TABLE roster_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  attribution TEXT NOT NULL,
  allowed_use TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_change_at INTEGER,
  last_error TEXT
);
INSERT INTO roster_sources(id,name,url,attribution,allowed_use,checked_at,enabled) VALUES
  ('riot-gcd','Riot Global Contract Database','https://competitiveops.riotgames.com/en-US/VALORANT',
   'Roster data: Riot Games Global Contract Database',
   'Accepted by the project owner on 2026-11-17: handles, team, role, roster status and contract end year. Legal names, residency and contact details are never stored.',
   '2026-11-17',1);

-- origin_key is the external key the entity was first created from; it only links the two
-- inserts of one import together. Identity across sources lives in roster_external_ids.
CREATE TABLE roster_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT,
  league TEXT NOT NULL,
  origin_key TEXT NOT NULL UNIQUE
);
CREATE TABLE roster_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  origin_key TEXT NOT NULL UNIQUE
);
CREATE TABLE roster_external_ids (
  source_id TEXT NOT NULL REFERENCES roster_sources(id),
  kind TEXT NOT NULL CHECK(kind IN ('team','person')),
  external_key TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY(source_id,kind,external_key)
);

-- One row per accepted complete read of a source. base_run_id is the published run it was
-- computed against: two writers racing from the same base collide on the UNIQUE and the
-- loser's whole batch rolls back, so a stale run can never overwrite a newer one.
CREATE TABLE roster_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES roster_sources(id),
  run_key TEXT NOT NULL,
  base_run_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  pending_count INTEGER NOT NULL,
  UNIQUE(source_id,run_key),
  UNIQUE(source_id,base_run_id)
);

-- What the source said in one run: presence at observation time, nothing more.
CREATE TABLE roster_observations (
  run_id INTEGER NOT NULL REFERENCES roster_import_runs(id),
  person_id INTEGER NOT NULL REFERENCES roster_people(id),
  team_id INTEGER NOT NULL REFERENCES roster_teams(id),
  kind TEXT NOT NULL CHECK(kind IN ('player','coach','staff')),
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  contract_end TEXT,
  PRIMARY KEY(run_id,person_id,team_id,kind)
);
-- "What did the source say about this tenure as of date X" (role/status/contract history).
CREATE INDEX roster_observations_member ON roster_observations(person_id,team_id,kind);

-- Rows the import could not attach to one identity (duplicate handle, missing fields).
-- They never reach memberships; they wait here for a mapping.
CREATE TABLE roster_pending (
  run_id INTEGER NOT NULL REFERENCES roster_import_runs(id),
  reason TEXT NOT NULL,
  raw_row TEXT NOT NULL
);
CREATE INDEX roster_pending_run ON roster_pending(run_id);

-- Tenure intervals projected from consecutive complete runs. Bounds, not dates:
--   joined somewhere in (start_after, start_before]   start_after NULL = before tracking began
--   left somewhere in   (last_seen_at, end_before]     end_before NULL = still observed
-- A rejoin is a new row; a person can hold several kinds or teams at once.
CREATE TABLE roster_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES roster_sources(id),
  person_id INTEGER NOT NULL REFERENCES roster_people(id),
  team_id INTEGER NOT NULL REFERENCES roster_teams(id),
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  contract_end TEXT,
  start_after INTEGER,
  start_before INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  end_before INTEGER,
  first_run_id INTEGER NOT NULL,
  last_run_id INTEGER NOT NULL
);
CREATE INDEX roster_memberships_team ON roster_memberships(team_id,start_before);
CREATE INDEX roster_memberships_person ON roster_memberships(person_id,start_before);
CREATE UNIQUE INDEX roster_memberships_open ON roster_memberships(source_id,person_id,team_id,kind) WHERE end_before IS NULL;
