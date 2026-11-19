import { resolveCall } from './calls.js';
import { BINGO, CALL, CALL_RULES, ECONOMY, TRACKED_MAX } from './rules.js';
import { openPack } from './packs.js';
import { scoreSeries } from '../shared/scoring.js';

// One player's collection game. State is plain data (saved as JSON):
//   collection: pids you own          tracked: up to 10 of them that score points
//   credits, streak, packsOpened      calls: { [matchId]: call }
//   history: one entry per resolved matchday
// The feed (replay/live) is passed in, never stored.

export function createCollection({ seed, now = Math.floor(Date.now() / 1000) }) {
  const collection = [];
  return {
    v: 1,
    seed,
    createdAt: now,   // only matches that start after this score for you
    collection,
    tracked: [],
    credits: 0,
    streak: 0,
    packsOpened: 0,
    freePacks: ECONOMY.freeStarterPacks,
    calls: {},
    history: [],
    freeSwaps: 3,
    // Which ten were Tracked when: a match scores the set that was Tracked when it STARTED,
    // so swapping after kick-off never changes a result already in motion.
    trackedLog: [{ t: 0, tracked: [] }],
    // Matches whose result you have revealed, with the report that scored them.
    revealed: {},
  };
}

export function trackedAt(state, unix) {
  let set = state.trackedLog[0].tracked;
  for (const entry of state.trackedLog) if (entry.t <= unix) set = entry.tracked;
  return set;
}

export const swapFee = tier => ECONOMY.swapBase + (ECONOMY.swapByTier[tier] ?? 0);

// Swap a Tracked player for another card you own. The first few swaps are free;
// after that it costs credits, more for better cards. Returns a new state.
export function swapTracked(state, outPid, inPid, tierOf, now = Math.floor(Date.now() / 1000)) {
  if (!state.tracked.includes(outPid)) throw new Error('not tracked');
  if (!state.collection.includes(inPid)) throw new Error('you do not own that card');
  if (state.tracked.includes(inPid)) throw new Error('already tracked');
  const free = state.freeSwaps > 0;
  const fee = free ? 0 : swapFee(tierOf(inPid));
  if (state.credits < fee) throw new Error('not enough credits');
  const tracked = state.tracked.map(p => (p === outPid ? inPid : p));
  return {
    ...state,
    tracked,
    trackedLog: [...state.trackedLog, { t: now, tracked }],
    credits: state.credits - fee,
    freeSwaps: free ? state.freeSwaps - 1 : state.freeSwaps,
  };
}

// Pay for one extra bingo card. The card itself lives on the server; this only takes the credits.
export function buyBingoCard(state) {
  if (state.credits < BINGO.cardCost) throw new Error('not enough credits');
  return { ...state, credits: state.credits - BINGO.cardCost };
}

export function buyPack(state, pool, now = Math.floor(Date.now() / 1000)) {
  if (!pool.length) throw new Error('Cards are unavailable right now. Try again later.');
  const free = (state.freePacks ?? 0) > 0;
  if (!free && state.credits < ECONOMY.packCost) throw new Error('not enough credits');
  const { cards, refund } = openPack(state.seed, state.packsOpened, pool, state.collection);
  const tracked = [...state.tracked, ...cards.slice(0, TRACKED_MAX - state.tracked.length)];
  return {
    state: {
      ...state,
      collection: [...state.collection, ...cards],
      tracked,
      trackedLog: tracked.length === state.tracked.length ? state.trackedLog : [...state.trackedLog, { t: now, tracked }],
      credits: state.credits - (free ? 0 : ECONOMY.packCost) + refund,
      packsOpened: state.packsOpened + 1,
      freePacks: free ? state.freePacks - 1 : 0,
    },
    cards,
    refund,
  };
}

export function setCall(state, matchId, call) {
  return { ...state, calls: { ...state.calls, [matchId]: call } };
}

// Resolve ONE finished series (the unit of a spoiler-guarded reveal). Scores your call
// and the cards you were Tracking when it started, pays credits, updates the streak, and
// records the report so it can never be scored twice. Returns { state, report }.
export function resolveSeries(state, series, { teamOf }) {
  state = rescoreCalls(state);   // an old save is rescored before anything new is scored on it
  const done = state.revealed[series.matchId];
  if (done?.unseen) {
    const report = { ...done, unseen: false };   // already scored by settleCalls: revealing only lifts the guard
    return { state: { ...state, revealed: { ...state.revealed, [series.matchId]: report } }, report };
  }
  if (done) return { state, report: done };
  // Matches that started before you joined can be revealed but never score, so history is not free points.
  if ((series.startsAt ?? Infinity) < (state.createdAt ?? 0)) {
    const report = { matchId: series.matchId, callPoints: 0, trackedPoints: 0, total: 0, call: null, result: null, trackedLines: [], preJoin: true, winnerTag: series.teams[(series.winner ?? 1) - 1]?.tag ?? null };
    return { state: { ...state, revealed: { ...state.revealed, [series.matchId]: report } }, report };
  }
  const tracked = trackedAt(state, series.startsAt ?? Number.MAX_SAFE_INTEGER);
  const points = scoreSeries(series);
  const trackedLines = tracked
    .map(pid => ({ pid, total: points.get(pid)?.total }))
    .filter(l => l.total != null)
    .sort((a, b) => b.total - a.total);
  const trackedPoints = trackedLines.reduce((sum, l) => sum + l.total, 0);

  const call = state.calls[series.matchId];
  let streak = state.streak;
  let result = null;
  if (call && call.winner != null) {
    result = resolveCall(call, series, points, { tracked, teamOf, streak });
    streak = result.winnerRight ? streak + 1 : 0;
  }
  const callPoints = result?.total ?? 0;
  const report = {
    matchId: series.matchId,
    callPoints,
    trackedPoints,
    total: callPoints + trackedPoints,
    call: call ?? null,
    result,
    trackedLines,
    winnerTag: result?.facts.winnerTag ?? series.teams[(series.winner ?? 1) - 1]?.tag ?? null,
  };
  return {
    state: {
      ...state,
      streak,
      credits: state.credits + report.total * ECONOMY.creditsPerPoint,
      revealed: { ...state.revealed, [series.matchId]: report },
      history: [...state.history, { matchId: series.matchId, callPoints, trackedPoints, called: Boolean(result), right: Boolean(result?.winnerRight) }],
    },
    report,
  };
}

// Score every finished series you called but have not revealed, oldest first so the streak runs
// in match order. Points and credits count now; the report stays `unseen`, so the match card is
// still spoiler-guarded until you reveal it. `series` is any list of fetched series.
export function settleCalls(state, series, { teamOf }) {
  const due = series
    .filter(s => s.status === 'final' && state.calls[s.matchId]?.winner != null && !state.revealed[s.matchId])
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  for (const s of due) {
    const { state: next, report } = resolveSeries(state, s, { teamOf });
    state = { ...next, revealed: { ...next.revealed, [s.matchId]: { ...report, unseen: true } } };
  }
  return state;
}

// Rescore every scored call under the current CALL values, keeping which parts were right and
// the streak multiplier it had, and pay the difference in credits. A save without `callRules` is
// on rule 1 (backing paid 2 per Tracked player, which recovers the count). resolveSeries calls
// this first, so a save never holds a report from newer rules without being marked.
export function rescoreCalls(state) {
  if ((state.callRules ?? 1) >= CALL_RULES) return state;
  const revealed = { ...state.revealed };
  const callPoints = {};
  let credits = state.credits;
  for (const [id, report] of Object.entries(state.revealed)) {
    const result = report.result;
    if (!result) continue;
    const old = result.lines;
    const lines = {
      winner: old.winner > 0 ? CALL.winner : 0,
      exactScore: old.exactScore > 0 ? CALL.exactScore : 0,
      star: result.starRight ? CALL.star : old.star > 0 ? CALL.starTop3 : 0,
      backing: Math.min(CALL.backingCap, (old.backing / 2) * CALL.backing),
      againstGrain: old.againstGrain > 0 ? CALL.againstGrain : 0,
    };
    const total = Math.round(Object.values(lines).reduce((a, b) => a + b, 0) * result.multiplier);
    credits += (total - report.callPoints) * ECONOMY.creditsPerPoint;
    callPoints[id] = total;
    revealed[id] = { ...report, callPoints: total, total: total + report.trackedPoints, result: { ...result, lines, total } };
  }
  return {
    ...state,
    callRules: CALL_RULES,
    credits,
    revealed,
    history: state.history.map(h => (h.matchId in callPoints ? { ...h, callPoints: callPoints[h.matchId] } : h)),
  };
}

export const totalScore = state => state.history.reduce((sum, h) => sum + h.callPoints + h.trackedPoints, 0);
export const callRecord = state => ({
  made: state.history.filter(h => h.called).length,
  right: state.history.filter(h => h.right).length,
});
