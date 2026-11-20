// Roster guesses: a set of moves on one team, each "X replaced by Y" or "X leaving for Team".
// A move becomes legs: X leaves (any roster_depart) plus someone joins (roster_add at that team).
// Legs settle from Riot GCD roster events at the next roster lock. Each right leg scores points;
// nothing is staked. Guesses staked in credits before points-only (stake set) still settle as
// placed: each hit leg pays its share of stake x (legs + 1).

// ponytail: hand-kept VCT roster lock dates; add each split's date here (or feed it) as Riot announces them.
export const ROSTER_LOCKS = ['2027-01-12T00:00:00Z'];
export const nextLock = t => ROSTER_LOCKS.map(d => Date.parse(d) / 1000).find(x => x > t) ?? null;

export const TRANSFER = { maxMoves: 5, pointsPerLeg: 10 };
export const multiplierOf = legs => legs + 1;
export const payoutOf = (stake, legs, hits) => (legs ? Math.floor(stake * multiplierOf(legs) * hits / legs) : 0);
export const pointsOf = hits => hits * TRANSFER.pointsPerLeg;

// What a guess is worth, for display: points for points-only guesses, credits for older staked ones.
// Before settling it is the most it can score; after, what it scored.
export function scoreOf(g) {
  const settled = g.settledAt != null;
  if (g.stake == null) return { unit: 'PTS', settled, value: settled ? g.points : pointsOf(g.legs.length) };
  return { unit: 'CR', settled, value: settled ? g.payout : payoutOf(g.stake, g.legs.length, g.legs.length) };
}

const clean = s => String(s ?? '').trim().replace(/\s+/g, ' ');
// Riot GCD identity is "player|league" (worker/feed/roster.js), so a join is matched in the team's league.
export const identityOf = (player, league) => `${clean(player).toLocaleLowerCase('en-US')}|${clean(league).toLocaleLowerCase('en-US')}`;

// moves: [{ out: {key, player, team, league}, in?: name, to?: {team, league} }] -> unique legs.
export function legsFor(moves) {
  const legs = new Map();
  const add = leg => legs.set(`${leg.type}:${leg.key}:${leg.team}`, leg);
  for (const m of moves) {
    add({ type: 'leave', key: m.out.key, player: m.out.player, team: m.out.team });
    if (m.in) add({ type: 'join', key: identityOf(m.in, m.out.league), player: clean(m.in), team: m.out.team });
    if (m.to) add({ type: 'join', key: identityOf(m.out.player, m.to.league), player: m.out.player, team: m.to.team });
  }
  return [...legs.values()];
}

// Only events first seen after the guess and before its lock count. A roster_depart carries the player's
// new team (or the old one when released), so leave legs match on identity alone.
export function scoreLegs(guess, events) {
  const window = events.filter(e => e.firstSeenAt >= guess.placedAt && e.firstSeenAt < guess.deadline);
  return guess.legs.map(leg => ({
    ...leg,
    hit: window.some(e => leg.type === 'leave'
      ? e.changeType === 'roster_depart' && e.identityKey === leg.key
      : e.changeType === 'roster_add' && e.identityKey === leg.key && e.team === leg.team),
  }));
}
