import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMatch } from '../scripts/feed/normalize.js';
import { mapMvps, scoreMap, scoreSeries } from '../src/engine/shared/scoring.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/feed/match-753462.v2.json', import.meta.url), 'utf8'));
const match = normalizeMatch(golden.data.segments[0]);
const row = (extra = {}) => ({ vlrId: 1, side: 1, k: 20, d: 15, a: 5, fk: 3, fd: 1, kast: 75, r2: 1.2, mk: [4, 2, 1, 0], cl: [1, 0, 0, 0, 0], ...extra });

test('a hand-computed line: every component lands where the rules say', () => {
  const { total, lines } = scoreMap(row(), { won: true, mvp: true, clinched: true });
  assert.deepEqual(lines, {
    frags: 20 * 2 + 5 - 15,        // 30
    openings: 3 * 2 - 1 * 2,       // 4
    highlights: 2 * 3 + 1 * 6 + 2, // 3Ks, a 4K and a 1v1 = 14
    kast: 2,
    result: 4 + 5,
    mvp: 5,
  });
  assert.equal(total, 30 + 4 + 14 + 2 + 9 + 5);
});

test('KAST bands and a bad day can go negative', () => {
  assert.equal(scoreMap(row({ kast: 85 })).lines.kast, 4);
  assert.equal(scoreMap(row({ kast: 65 })).lines.kast, 0);
  assert.equal(scoreMap(row({ kast: 40 })).lines.kast, -2);
  const bad = scoreMap(row({ k: 8, d: 17, a: 2, fk: 0, fd: 4, kast: 55, mk: [0, 0, 0, 0], cl: [0, 0, 0, 0, 0] }));
  assert.ok(bad.total < 0);
});

test('MVP ties all score; lines always sum to the total', () => {
  assert.equal(mapMvps([row({ vlrId: 1, r2: 1.3 }), row({ vlrId: 2, r2: 1.3 }), row({ vlrId: 3, r2: 1 })]).size, 2);
  const r = scoreMap(row(), { won: true });
  assert.equal(Object.values(r.lines).reduce((a, b) => a + b, 0), r.total);
});

test('a real series: everyone scores, the series bonus lands once on the last map, winners outscore on average', () => {
  const points = scoreSeries(match);
  assert.equal(points.size, 10);
  for (const [, p] of points) assert.equal(p.maps.length, 2);
  const nsAvg = [...points].filter(([id]) => match.maps[0].players.find(p => p.vlrId === id).side === 2).reduce((s, [, p]) => s + p.total, 0) / 5;
  const xlgAvg = [...points].filter(([id]) => match.maps[0].players.find(p => p.vlrId === id).side === 1).reduce((s, [, p]) => s + p.total, 0) / 5;
  assert.ok(nsAvg > xlgAvg, `winners ${nsAvg} should beat losers ${xlgAvg}`);
  // series bonus (+5) appears on map 2 only, for the winning side
  const winner = match.maps[0].players.find(p => p.side === 2).vlrId;
  assert.equal(points.get(winner).maps[0].lines.result, 4);
  assert.equal(points.get(winner).maps[1].lines.result, 4 + 5);
});
