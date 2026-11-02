// Synthetic league context for balance tests until real replay data exists.
// Players are the real cards of the Champions 2026 teams; per-map points are
// drawn around the card prior with the spread seen in the first real matches.
import cards from '../../shared/src/data/cards.json' with { type: 'json' };
import { mulberry32 } from '../../shared/src/engine/perfectRun.js';
import { buildValueTable } from '../../src/engine/fantasy/values.js';

const TEAMS = new Set(['100T', 'LOUD', 'NRG', 'G2', 'TL', 'FUT', 'VIT', 'GE', 'NS', 'PRX', 'T1', 'TYL', 'JDG', 'EDG', 'XLG']);

export function synthPlayers() {
  return cards.filter(c => c.league === 'vct' && TEAMS.has(c.org)).map((c, i) => ({
    pid: i + 1, card: c, team: c.org, role: String(c.role).toLowerCase(),
  }));
}

export function synthCtx(seed = 1) {
  const rng = mulberry32(seed);
  const list = synthPlayers();
  const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.73;
  const rows = list.map(p => ({
    pid: p.pid, card: p.card,
    mapPoints: [0, 1, 2, 3].map(() => Math.round(30 + 0.6 * (p.card.rating - 82) + gauss() * 14)),
  }));
  const values = buildValueTable({ players: rows });
  return {
    players: Object.fromEntries(list.map(p => [p.pid, p])),
    values,
    seriesNext: {},
  };
}


// Feed-format matches over the synthetic Champions pool: matchday 1 has eight
// series (every team plays), matchday 2 four, matchday 3 two. Stats track the
// card rating with noise, so higher-rated players score more on average.
export function synthMatches(seed = 1) {
  const rng = mulberry32(seed * 31);
  const g = () => (rng() + rng() + rng() + rng() - 2) * 1.73;
  const list = synthPlayers();
  const byTeam = {};
  for (const p of list) (byTeam[p.team] ??= []).push(p);
  const teams = Object.keys(byTeam).filter(t => byTeam[t].length >= 5).sort();
  const row = (p, side) => {
    const skill = 0.6 * (p.card.rating - 82);
    const k = Math.max(3, Math.round(16 + skill / 3 + g() * 4));
    return {
      vlrId: p.pid, handle: p.card.player, side, teamTag: p.team, agent: String(p.card.agents[0]).toLowerCase(),
      r2: Math.max(0.3, 1 + skill / 40 + g() * 0.2), acs: 230, k, d: Math.max(3, Math.round(15 - skill / 6 + g() * 3)),
      a: Math.max(0, Math.round(5 + g() * 2)), kast: Math.min(95, Math.max(40, Math.round(72 + g() * 6))),
      adr: 150, hs: 25, fk: Math.max(0, Math.round(2 + g())), fd: Math.max(0, Math.round(2 + g())),
      mk: [Math.max(0, Math.round(2 + g())), Math.max(0, Math.round(0.7 + g() * 0.6)), 0, 0], cl: [0, 0, 0, 0, 0],
    };
  };
  let id = 1000;
  const series = (a, b, roundId, startsAt) => {
    const A = byTeam[a].slice(0, 5);
    const B = byTeam[b].slice(0, 5);
    const maps = [0, 1].map(n => ({
      gameId: ++id, mapNo: n + 1, map: 'Lotus', score: [13, 8 + n],
      players: [...A.map(p => row(p, 1)), ...B.map(p => row(p, 2))],
    }));
    return {
      matchId: ++id, eventId: 1, bestOf: 3, status: 'final', roundId, startsAt, winner: 1,
      teams: [{ tag: a, score: 2 }, { tag: b, score: 0 }], maps,
    };
  };
  const out = [];
  let alive = teams;
  ['1:2026-09-24', '1:2026-09-25', '1:2026-09-26'].forEach((roundId, d) => {
    const next = [];
    for (let i = 0; i + 1 < alive.length; i += 2) {
      out.push(series(alive[i], alive[i + 1], roundId, d * 1000 + i));
      next.push(alive[i]);
    }
    alive = next;
  });
  return out;
}
