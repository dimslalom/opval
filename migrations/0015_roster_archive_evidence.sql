-- Existing live runs have no per-capture URL. Wayback runs hold the exact replay permalink.
ALTER TABLE roster_import_runs ADD COLUMN archive_url TEXT;
