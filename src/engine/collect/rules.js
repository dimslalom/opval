// Collect-and-call rules. One place so numbers are tuned in one edit.
// No real money, no wagering: credits are only earned by playing, calls score
// points and never cost anything, and nothing is ever lost on a wrong call.
export const TRACKED_MAX = 10;

// Sized against Tracked scoring: a Tracked player who plays averages ~70 a series (best ~155,
// VCT 2026 data). A perfect call at full streak (105 x 1.5) matches the best single player game;
// winner + score (55) is most of an average one.
export const CALL = {
  winner: 30,          // the right team won
  exactScore: 25,      // ...and you had the exact map score (e.g. 2-1)
  star: 50,            // the player you named scored the most in the series
  starTop3: 20,        // ...or finished in the series' top three
  backing: 4,          // per Tracked player on the team you called, when you are right
  backingCap: 20,
  againstGrain: 10,    // right while Tracking players on the OTHER team (a hedge pays a little)
  streakStep: 0.1,     // multiplier +10% per consecutive right winner call
  streakCap: 1.5,
};

// Bump when CALL changes; saves scored under older rules are rescored on load (rescoreCalls).
export const CALL_RULES = 2;

export const ECONOMY = {
  creditsPerPoint: 1,
  packCost: 500,
  packSize: 5,
  swapBase: 50,
  swapByTier: { bronze: 0, silver: 50, gold: 150, icon: 300 },
  duplicateRefund: 100,
  freeStarterPacks: 2,
};

// Bingo: one card a day is free, extras cost credits, and the cap keeps a day's cards bounded.
export const BINGO = { freeCards: 1, cardCost: 100, maxCards: 5 };

// Pack odds by card tier (a gold card is about 13% of the pool, so this is generous).
export const PACK_ODDS = { gold: 0.14, silver: 0.38, bronze: 0.48 };

