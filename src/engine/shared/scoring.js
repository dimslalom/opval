import { SCORING } from './scoringRules.js';

// Per-map fantasy points from one real stat row. Integers only, and the lines
// sum exactly to the total so the UI can show why a player scored.
//
// Row shape is the feed's player row: { vlrId, side, k, d, a, fk, fd, kast, r2,
// mk: [2K, 3K, 4K, 5K], cl: [1v1..1v5] }.

const kastPoints = kast => SCORING.kastBands.find(([from]) => kast >= from)[1];

// Players sharing the top R2.0 on a map all score the MVP bonus.
export function mapMvps(rows) {
  const best = Math.max(...rows.map(r => r.r2));
  return new Set(rows.filter(r => r.r2 === best).map(r => r.vlrId));
}

export function scoreMap(row, { won = false, mvp = false, clinched = false } = {}) {
  const frags = row.k * SCORING.kill + row.a * SCORING.assist + row.d * SCORING.death;
  const openings = row.fk * SCORING.firstKill + row.fd * SCORING.firstDeath;
  const multi = row.mk[1] * SCORING.multi[3] + row.mk[2] * SCORING.multi[4] + row.mk[3] * SCORING.multi[5];
  const clutch = row.cl.reduce((sum, n, i) => sum + n * SCORING.clutch[i + 1], 0);
  const lines = {
    frags,
    openings,
    highlights: multi + clutch,
    kast: kastPoints(row.kast),
    result: (won ? SCORING.mapWin : 0) + (clinched ? SCORING.seriesWin : 0),
    mvp: mvp ? SCORING.mapMvp : 0,
  };
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  return { total, lines };
}

// Score every player in a normalized match (see scripts/feed/normalize.js).
// Returns Map<vlrId, { total, maps: [{ gameId, map, total, lines }] }>.
export function scoreSeries(match) {
  const out = new Map();
  const maps = match.maps.filter(m => m.players.length > 0);
  const scored = maps.length ? maps : [];
  scored.forEach((map, i) => {
    const mvps = mapMvps(map.players);
    const winnerSide = map.score[0] > map.score[1] ? 1 : 2;
    const lastMap = i === scored.length - 1;
    // The series winner is credited on the map that decided it, only if stats exist for it.
    const seriesWinnerSide = match.winner ?? null;
    for (const row of map.players) {
      const result = scoreMap(row, {
        won: row.side === winnerSide,
        mvp: mvps.has(row.vlrId),
        clinched: lastMap && seriesWinnerSide === row.side,
      });
      const entry = out.get(row.vlrId) ?? { total: 0, maps: [] };
      entry.total += result.total;
      entry.maps.push({ gameId: map.gameId, map: map.map, total: result.total, lines: result.lines });
      out.set(row.vlrId, entry);
    }
  });
  return out;
}
