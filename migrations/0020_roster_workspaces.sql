-- Private saved work (sandbox lineups) and the read-only links made from it.
-- A workspace belongs to one account and is only ever read or written through that account's
-- session. A share is a frozen copy of one revision: later edits never reach it, revoking stops
-- the link, and only the hash of its token is stored.
CREATE TABLE roster_workspaces (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('sandbox')),
  title      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  schema     INTEGER NOT NULL DEFAULT 1,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX roster_workspaces_owner ON roster_workspaces(user_id, updated_at);

CREATE TABLE roster_shares (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX roster_shares_workspace ON roster_shares(workspace_id, revoked_at);
CREATE INDEX roster_shares_owner ON roster_shares(user_id, created_at);
