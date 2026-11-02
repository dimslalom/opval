import test from 'node:test';
import assert from 'node:assert/strict';
import cards from '../shared/src/data/cards.json' with { type: 'json' };
import { buildReplay } from '../src/engine/fantasy/replay.js';
import { scoreSeries } from '../src/engine/shared/scoring.js';
import { resolveCall, seriesFacts, streakMultiplier } from '../src/engine/collect/calls.js';
import { buyBingoCard, buyPack, callRecord, createCollection, rescoreCalls, resolveMatchday, resolveSeries, setCall, settleCalls, swapFee, swapTracked, totalScore, trackedAt } from '../src/engine/collect/game.js';
import { openPack, starterCollection } from '../src/engine/collect/packs.js';
import { BINGO, CALL, ECONOMY, TRACKED_MAX } from '../src/engine/collect/rules.js';
import { synthMatches } from './fixtures/fantasySynth.js';

const replay = () => buildReplay({ matches: synthMatches(1), cards });
const poolOf = r => Object.values(r.players).filter(p => p.card).map(p => ({ pid: p.pid, tier: p.card.palette }));
const teamOfFn = r => pid => r.players[pid].team;
const withCards = (state, pool) => {
  const hand = starterCollection(state.seed, pool);
  return { ...state, collection: hand, tracked: hand, freePacks: 0, trackedLog: [{ t: 0, tracked: hand }] };
};

test('streak multiplier grows 10% per right call and caps at 1.5', () => {
  assert.equal(streakMultiplier(0), 1);
  assert.equal(streakMultiplier(3), 1.3);
  assert.equal(streakMultiplier(50), CALL.streakCap);
});

test('a call is scored line by line and is never negative', () => {
  const r = replay();
  const series = r.matchdays[0].matches[0]; // synth: team 0 wins 2-0
  const points = scoreSeries(series);
  const facts = seriesFacts(series, points);
  assert.equal(facts.winnerTag, series.teams[0].tag);
  const star = facts.star[0];

  const perfect = resolveCall({ winner: facts.winnerTag, score: facts.score, star }, series, points, { tracked: [], teamOf: teamOfFn(r), streak: 0 });
  assert.equal(perfect.total, CALL.winner + CALL.exactScore + CALL.star);

  const wrong = resolveCall({ winner: series.teams[1].tag }, series, points, { tracked: [], teamOf: teamOfFn(r), streak: 5 });
  assert.equal(wrong.total, 0);
  assert.equal(wrong.multiplier, 1);

  const starOnly = resolveCall({ winner: series.teams[1].tag, star }, series, points, { tracked: [], teamOf: teamOfFn(r) });
  assert.equal(starOnly.total, CALL.star); // the star read pays even when the winner was wrong
});

test('backing: Tracked players on the team you called add a capped bonus when you are right', () => {
  const r = replay();
  const series = r.matchdays[0].matches[0];
  const points = scoreSeries(series);
  const winner = series.teams[0].tag;
  const mine = Object.values(r.players).filter(p => p.team === winner).map(p => p.pid);
  const call = { winner };
  const none = resolveCall(call, series, points, { tracked: [], teamOf: teamOfFn(r) });
  const some = resolveCall(call, series, points, { tracked: mine.slice(0, 3), teamOf: teamOfFn(r) });
  assert.equal(some.lines.backing, 3 * CALL.backing);
  assert.equal(some.total - none.total, 3 * CALL.backing);
  const capped = resolveCall(call, series, points, { tracked: mine, teamOf: teamOfFn(r) });
  assert.ok(capped.lines.backing <= CALL.backingCap);
});

test('against the grain: hedging pays a little only when you are right', () => {
  const r = replay();
  const series = r.matchdays[0].matches[0];
  const points = scoreSeries(series);
  const loser = series.teams[1].tag;
  const hedge = Object.values(r.players).find(p => p.team === loser).pid;
  const res = resolveCall({ winner: series.teams[0].tag }, series, points, { tracked: [hedge], teamOf: teamOfFn(r) });
  assert.equal(res.lines.againstGrain, CALL.againstGrain);
});

test('new accounts start with no cards and two free packs', () => {
  const state = createCollection({ seed: 7, now: 100 });
  assert.deepEqual(state.collection, []);
  assert.deepEqual(state.tracked, []);
  assert.equal(state.freePacks, 2);
  assert.equal(state.credits, 0);
  assert.deepEqual(state.trackedLog, [{ t: 0, tracked: [] }]);
});

test('legacy starter hand helper remains deterministic for replay fixtures', () => {
  const pool = poolOf(replay());
  const a = starterCollection(7, pool);
  assert.equal(new Set(a).size, ECONOMY.starterCards);
  assert.deepEqual(a, starterCollection(7, pool));
  assert.notDeepEqual(a, starterCollection(8, pool));
});

test('packs never repeat a card you own and refund when the pool runs dry', () => {
  const pool = poolOf(replay());
  const owned = starterCollection(3, pool);
  const { cards: got } = openPack(3, 0, pool, owned);
  assert.equal(got.length, ECONOMY.packSize);
  assert.ok(got.every(pid => !owned.includes(pid)));
  const all = pool.map(e => e.pid);
  const dry = openPack(3, 1, pool, all);
  assert.equal(dry.cards.length, 0);
  assert.equal(dry.refund, ECONOMY.packSize * ECONOMY.duplicateRefund);
});

test('Tracked: at most ten, swaps need a card you own, the first swaps are free, then they cost credits', () => {
  const r = replay();
  const pool = poolOf(r);
  let s = withCards(createCollection({ seed: 5, now: 0 }), pool);
  assert.equal(s.tracked.length, TRACKED_MAX);
  const tierOf = pid => r.players[pid].card.palette;
  const outsider = pool.find(e => !s.collection.includes(e.pid)).pid;
  assert.throws(() => swapTracked(s, s.tracked[0], outsider, tierOf), /do not own/);

  // give ourselves more cards, then swap past the free ones
  s = { ...s, collection: [...s.collection, ...pool.slice(0, 40).map(e => e.pid).filter(p => !s.collection.includes(p))] };
  const spare = () => s.collection.find(p => !s.tracked.includes(p));
  for (let i = 0; i < 3; i++) s = swapTracked(s, s.tracked[0], spare(), tierOf);
  assert.equal(s.freeSwaps, 0);
  assert.throws(() => swapTracked(s, s.tracked[0], spare(), tierOf), /not enough credits/);
  s = { ...s, credits: 1000 };
  const incoming = spare();
  const fee = swapFee(tierOf(incoming));
  const after = swapTracked(s, s.tracked[0], incoming, tierOf);
  assert.equal(after.credits, 1000 - fee);
  assert.equal(new Set(after.tracked).size, TRACKED_MAX);
});

test('two free packs fill the tracked hand, then packs cost credits', () => {
  const pool = poolOf(replay());
  let s = createCollection({ seed: 2, now: 0 });
  const first = buyPack(s, pool, 100);
  s = first.state;
  assert.equal(s.credits, 0);
  assert.equal(s.freePacks, 1);
  assert.deepEqual(s.tracked, first.cards);
  assert.deepEqual(trackedAt(s, 99), []);
  assert.deepEqual(trackedAt(s, 100), first.cards);
  const second = buyPack(s, pool, 200);
  s = second.state;
  assert.equal(s.freePacks, 0);
  assert.equal(s.collection.length, ECONOMY.packSize * 2);
  assert.equal(s.tracked.length, TRACKED_MAX);
  assert.equal(new Set(s.collection).size, s.collection.length);
  assert.throws(() => buyPack(s, pool), /not enough credits/);
  const paid = buyPack({ ...s, credits: 800 }, pool, 300);
  assert.equal(paid.state.credits, 800 - ECONOMY.packCost);
  assert.equal(paid.state.tracked.length, TRACKED_MAX);
});

test('a full replay: calls and Tracked points both land, credits track points, skipped calls do not break a streak', () => {
  const r = replay();
  const pool = poolOf(r);
  let s = withCards(createCollection({ seed: 9, now: 0 }), pool);
  const teamOf = teamOfFn(r);
  let totalCredits = 0;
  for (const md of r.matchdays) {
    // call the first team in each series; skip every third series
    md.matches.forEach((series, i) => { if (i % 3 !== 2) s = setCall(s, series.matchId, { winner: series.teams[0].tag }); });
    const out = resolveMatchday(s, md, { teamOf });
    s = out.state;
    totalCredits += out.report.total;
    assert.equal(out.report.total, out.report.callPoints + out.report.trackedPoints);
    assert.ok(out.report.callPoints >= 0);
    assert.ok(out.report.callsRight <= out.report.callsMade);
  }
  // synthetic series are won by the first team, so every call made was right
  assert.ok(s.streak > 5);
  assert.equal(s.credits, totalCredits);
  assert.equal(totalScore(s), totalCredits);
  assert.equal(s.history.length, r.matchdays.length);
});

test('Tracked scoring only counts the ten you track', () => {
  const r = replay();
  const pool = poolOf(r);
  const s = withCards(createCollection({ seed: 4, now: 0 }), pool);
  const md = r.matchdays[0];
  const out = resolveMatchday(s, md, { teamOf: teamOfFn(r) });
  for (const line of out.report.trackedLines) assert.ok(s.tracked.includes(line.pid));
  const noneTracked = resolveMatchday({ ...s, tracked: [] }, md, { teamOf: teamOfFn(r) });
  assert.equal(noneTracked.report.trackedPoints, 0);
});

test('resolveSeries scores one match once: reveal is idempotent and pays credits', () => {
  const r = replay();
  const pool = poolOf(r);
  let s = withCards(createCollection({ seed: 6, now: 0 }), pool);
  const series = r.matchdays[0].matches[0];
  s = setCall(s, series.matchId, { winner: series.teams[0].tag });
  const first = resolveSeries(s, series, { teamOf: teamOfFn(r) });
  assert.equal(first.report.callPoints >= CALL.winner, true);
  assert.equal(first.state.credits, first.report.total);
  const again = resolveSeries(first.state, series, { teamOf: teamOfFn(r) });
  assert.equal(again.state.credits, first.state.credits);   // no double pay
  assert.equal(again.state.history.length, 1);
  assert.deepEqual(callRecord(first.state), { made: 1, right: 1 });
});

test('a match scores the cards you were Tracking when it started, not the ones you swap to afterwards', () => {
  const r = replay();
  const pool = poolOf(r);
  const tierOf = pid => r.players[pid].card.palette;
  let s = withCards(createCollection({ seed: 3, now: 0 }), pool);
  const series = r.matchdays[0].matches[0];
  const start = 1000;
  const startedSeries = { ...series, startsAt: start };
  // Track nobody who plays in this series at kick-off, then swap a participant in AFTER it started.
  const inSeries = new Set(series.maps.flatMap(m => m.players.map(p => p.vlrId)));
  const participant = [...inSeries][0];
  s = { ...s, collection: [...new Set([...s.collection, participant])] };
  s = { ...s, tracked: s.tracked.filter(p => !inSeries.has(p)), trackedLog: [{ t: 0, tracked: s.tracked.filter(p => !inSeries.has(p)) }] };
  assert.ok(s.tracked.length > 0);
  s = swapTracked(s, s.tracked[0], participant, tierOf, start + 500);   // swapped in after kick-off
  assert.ok(!trackedAt(s, start).includes(participant));
  assert.ok(trackedAt(s, start + 600).includes(participant));
  const out = resolveSeries(s, startedSeries, { teamOf: teamOfFn(r) });
  assert.ok(out.report.trackedLines.every(l => l.pid !== participant), 'the late swap must not score');
});

test('matches that started before you joined can be revealed but never score', () => {
  const r = replay();
  const pool = poolOf(r);
  const series = { ...r.matchdays[0].matches[0], startsAt: 5000 };
  const early = createCollection({ seed: 1, pool, now: 9000 });
  const out = resolveSeries(early, series, { teamOf: teamOfFn(r) });
  assert.equal(out.report.total, 0);
  assert.equal(out.report.preJoin, true);
  assert.equal(out.state.credits, 0);
  assert.equal(out.state.streak, 0);
  const joinedBefore = createCollection({ seed: 1, pool, now: 1000 });
  assert.ok(resolveSeries(joinedBefore, series, { teamOf: teamOfFn(r) }).report.preJoin !== true);
});

test('an extra bingo card costs its credits and cannot be bought without them', () => {
  const s = createCollection({ seed: 1, now: 0 });
  assert.throws(() => buyBingoCard({ ...s, credits: BINGO.cardCost - 1 }), /not enough credits/);
  const paid = buyBingoCard({ ...s, credits: BINGO.cardCost + 7 });
  assert.equal(paid.credits, 7);
  assert.equal(buyBingoCard({ ...s, credits: BINGO.cardCost }).credits, 0);
});

test('settleCalls scores unrevealed calls once, keeps every call, and leaves the reveal guarded', () => {
  const r = replay();
  let s = withCards(createCollection({ seed: 6, now: 0 }), poolOf(r));
  const [a, b] = r.matchdays[0].matches;
  s = setCall(s, a.matchId, { winner: a.teams[0].tag });
  s = setCall(s, 'later', { winner: 'X' });   // a call on a match that has not finished
  const settled = settleCalls(s, [{ ...a, status: 'final' }, { ...b, status: 'final' }], { teamOf: teamOfFn(r) });
  assert.deepEqual(settled.calls, s.calls);
  assert.equal(settled.revealed[a.matchId].unseen, true);
  assert.equal(settled.revealed[b.matchId], undefined);   // no call on b: left for the reveal tap
  assert.equal(settled.credits, settled.revealed[a.matchId].total);
  assert.equal(settleCalls(settled, [{ ...a, status: 'final' }], { teamOf: teamOfFn(r) }), settled);
  const shown = resolveSeries(settled, a, { teamOf: teamOfFn(r) });
  assert.equal(shown.report.unseen, false);
  assert.equal(shown.state.credits, settled.credits);   // revealing does not pay twice
  assert.equal(shown.state.history.length, 1);
});

test('rescoreCalls moves a rule-1 save to the current call values once, keeping the streak multiplier', () => {
  // Rule 1: winner 10 + exact score 10 + star top-3 5 + backing 2 x 2 = 29, x1.2 streak = 35.
  const result = { winnerRight: true, scoreRight: true, starRight: false, multiplier: 1.2, total: 35,
    lines: { winner: 10, exactScore: 10, star: 5, backing: 4, againstGrain: 0 } };
  const old = { ...createCollection({ seed: 1, now: 0 }), credits: 100 };
  delete old.callRules;
  old.revealed = { 7: { matchId: 7, callPoints: 35, trackedPoints: 40, total: 75, result },
    8: { matchId: 8, callPoints: 0, trackedPoints: 0, total: 0, result: null, preJoin: true } };
  old.history = [{ matchId: 7, callPoints: 35, trackedPoints: 40, called: true, right: true }];

  const s = rescoreCalls(old);
  const want = Math.round((CALL.winner + CALL.exactScore + CALL.starTop3 + 2 * CALL.backing) * 1.2);
  assert.equal(s.revealed[7].callPoints, want);
  assert.equal(s.revealed[7].total, want + 40);
  assert.equal(s.history[0].callPoints, want);
  assert.equal(s.credits, 100 + want - 35);
  assert.deepEqual(s.revealed[8], old.revealed[8]);
  assert.equal(rescoreCalls(s), s);   // once only
  assert.equal(totalScore(s), want + 40);
});
