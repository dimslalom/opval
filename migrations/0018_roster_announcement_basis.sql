-- Whether a manual roster entry rests on the team's own announcement or on reporting ("sources").
-- Both take priority over Riot's data on the team page until Riot's data agrees, but the page says
-- which one it is.
ALTER TABLE roster_announcements ADD COLUMN basis TEXT NOT NULL DEFAULT 'announced' CHECK(basis IN ('announced','reported'));
