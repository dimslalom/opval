-- Moves a team has announced that Riot's contract database does not show yet, entered by hand
-- (scripts/roster/announce.mjs). They are shown apart from Riot's data, labelled as announced, and
-- stop showing once Riot's data agrees (the person listed on the team for a join, gone for a leave).
CREATE TABLE roster_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES roster_teams(id),
  handle TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'player' CHECK(kind IN ('player','coach','staff')),
  move TEXT NOT NULL CHECK(move IN ('join','leave')),
  announced_on TEXT NOT NULL,
  source_url TEXT,
  added_at INTEGER NOT NULL,
  withdrawn_at INTEGER
);
CREATE INDEX roster_announcements_team ON roster_announcements(team_id);
