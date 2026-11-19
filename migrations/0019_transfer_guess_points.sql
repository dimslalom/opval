-- Transfer guesses score points, not credits: new guesses carry no stake (NULL) and earn `points`.
-- Guesses staked before this keep their stake and settle in credits exactly as placed.
CREATE TABLE transfer_bets_next (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team       TEXT NOT NULL,
  legs       TEXT NOT NULL,
  stake      INTEGER CHECK(stake IS NULL OR stake > 0),
  placed_at  INTEGER NOT NULL,
  deadline   INTEGER NOT NULL,
  hits       INTEGER,
  payout     INTEGER,
  points     INTEGER,
  settled_at INTEGER
);
INSERT INTO transfer_bets_next(id,user_id,team,legs,stake,placed_at,deadline,hits,payout,settled_at)
  SELECT id,user_id,team,legs,stake,placed_at,deadline,hits,payout,settled_at FROM transfer_bets;
DROP TABLE transfer_bets;
ALTER TABLE transfer_bets_next RENAME TO transfer_bets;
CREATE INDEX transfer_bets_user ON transfer_bets(user_id, placed_at);
CREATE INDEX transfer_bets_open ON transfer_bets(settled_at, deadline);
