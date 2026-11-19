-- Every successful read of a source, changed or not. Unchanged live reads create no import run,
-- so without this the timeline could not show where reads happened (and a quiet stretch of daily
-- reads would look like a gap in evidence).
CREATE TABLE roster_reads (
  source_id TEXT NOT NULL REFERENCES roster_sources(id),
  observed_at INTEGER NOT NULL,
  -- Kinds the read listed, comma-separated; NULL = every kind (players, coaches, staff).
  covers TEXT,
  PRIMARY KEY(source_id, observed_at)
);
ALTER TABLE roster_import_runs ADD COLUMN covers TEXT;
-- One row per day with a read, for timeline ticks: a team page reads at most one row per day of
-- history, not every 15-minute read (D1 bills every row a query reads).
CREATE TABLE roster_read_days (
  source_id TEXT NOT NULL REFERENCES roster_sources(id),
  day INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY(source_id, day)
);
-- Import lookups go from a membership's entity back to its external key; without this every
-- import scanned the whole external id table once per open membership.
CREATE INDEX roster_external_ids_entity ON roster_external_ids(source_id, kind, entity_id);
INSERT OR IGNORE INTO roster_reads(source_id, observed_at) SELECT source_id, observed_at FROM roster_import_runs WHERE observed_at IS NOT NULL;
INSERT OR IGNORE INTO roster_reads(source_id, observed_at) SELECT id, last_success_at FROM roster_sources WHERE last_success_at IS NOT NULL;
INSERT OR IGNORE INTO roster_read_days(source_id, day, first_at) SELECT source_id, observed_at / 86400, MIN(observed_at) FROM roster_reads GROUP BY source_id, observed_at / 86400;
