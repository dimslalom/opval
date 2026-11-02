import { useCallback, useEffect, useMemo, useState } from 'react';
import cards from '../../../../shared/src/data/cards.json';
import { buyPack, callRecord, createCollection, rescoreCalls, resolveSeries, setCall, settleCalls, swapFee, swapTracked, totalScore } from '../../../../src/engine/collect/game';
import { CALL_RULES } from '../../../../src/engine/collect/rules';
import { makeCardLookup } from '../../../../src/engine/shared/cardLookup';
import { useAccount } from './account';
import { fetchMatch, fetchPlayers } from './feed';
import { GameContext } from './gameContext';

// The one place the game's state lives: your save (localStorage), the players the feed
// knows (joined to the designed cards), and the actions that change them. Everything is
// local to this browser unless you sign in, which mirrors the save to your account (account.js).

const SAVE_KEY = import.meta.env.DEV && (new URLSearchParams(location.search).get('offline') === '1' || sessionStorage.getItem('opval-offline-preview') === '1') ? 'opval-offline-save' : 'opval-save';
const SAVE_VERSION = 2;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
    return raw && raw.v === SAVE_VERSION ? raw.state : null;
  } catch {
    return null;
  }
}

export function GameProvider({ children }) {
  const [feedPlayers, setFeedPlayers] = useState(null);
  const [saved, setSaved] = useState(load);
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetchPlayers().then(list => { if (live) setFeedPlayers(list ?? []); });
    return () => { live = false; };
  }, []);

  // Feed players joined to designed cards by handle + team tag. Only players with a card can be
  // owned (the card is the product), so they form the pool packs draw from.
  const { players, pool } = useMemo(() => {
    const lookup = makeCardLookup(cards);
    const byId = {};
    const entries = [];
    for (const p of feedPlayers ?? []) {
      const card = lookup(p.handle, p.teamTag);
      byId[p.vlrId] = { pid: p.vlrId, handle: p.handle, team: p.teamTag, lastPlayedAt: p.lastPlayedAt, card };
      if (card) entries.push({ pid: p.vlrId, tier: card.palette });
    }
    return { players: byId, pool: entries };
  }, [feedPlayers]);

  const ready = feedPlayers != null;
  const teamOf = useCallback(pid => players[pid]?.team ?? null, [players]);
  const tierOf = useCallback(pid => players[pid]?.card?.palette ?? 'bronze', [players]);

  // First visit: start with two free packs and no cards. The account's server save
  // replaces this temporary local state as soon as sign-in completes.
  const starter = useMemo(() => (ready ? createCollection({ seed }) : null), [ready, seed]);
  const state = saved ?? starter;

  const accountHook = useAccount({ state, setSaved });
  // Signing out also clears this device's copy, so the next account here starts fresh instead of inheriting it.
  const account = useMemo(() => ({
    ...accountHook,
    logout: async () => {
      await accountHook.logout();
      try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
      setSaved(null);
    },
  }), [accountHook]);

  // Calls on finished matches settle when the game loads, so credits and points never wait on a
  // reveal tap, and a save scored under older call values is rescored first (credits topped up).
  // Signed in, this waits for the server save so it settles that copy, not a stale one.
  // Reports stay unseen: the match card is still spoiler-guarded until you reveal it.
  const pending = state ? Object.keys(state.calls).filter(id => !state.revealed[id]).join() : '';
  const stale = Boolean(saved) && (saved.callRules ?? 1) < CALL_RULES;
  const canSettle = ready && accountHook.checked && !accountHook.user;
  useEffect(() => {
    if (!canSettle || (!pending && !stale)) return undefined;
    let live = true;
    Promise.all(pending ? pending.split(',').map(fetchMatch) : []).then(list => {
      if (live) setSaved(s => (s ? settleCalls(rescoreCalls(s), list.filter(Boolean), { teamOf }) : s));
    });
    return () => { live = false; };
  }, [canSettle, pending, stale, teamOf]);

  useEffect(() => {
    if (!state) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION, state })); } catch { /* storage blocked: progress will not persist */ }
  }, [state]);

  // Actions compute the next state from the current one OUTSIDE React's updater, so an engine
  // error ("not enough credits") becomes a message instead of a crash.
  const run = useCallback(fn => {
    if (!state) return null;
    try {
      const out = fn(state);
      setSaved(out.state ?? out);
      setError('');
      return out;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [state]);

  const remote = useCallback(async (op, fields) => {
    try {
      const result = await accountHook.perform(op, fields);
      setError('');
      return result;
    } catch (e) { setError(e.message); return null; }
  }, [accountHook.perform]);
  const actions = useMemo(() => ({
    call: (matchId, call) => accountHook.user ? remote('call', { matchId, call }) : run(s => setCall(s, matchId, call)),
    swap: (outPid, inPid) => accountHook.user ? remote('swap', { outPid, inPid }) : Boolean(run(s => swapTracked(s, outPid, inPid, tierOf))),
    buy: () => accountHook.user ? remote('pack') : run(s => buyPack(s, pool)),
    reveal: series => accountHook.user ? remote('reveal', { matchId: series.matchId }) : run(s => resolveSeries(s, series, { teamOf })),
    ...(import.meta.env.DEV && !accountHook.user && { devCredits: n => run(s => ({ ...s, credits: s.credits + n })) }),
  }), [accountHook.user, remote, run, tierOf, pool, teamOf]);

  const value = useMemo(() => ({
    ready, players, pool, state, error, teamOf, tierOf, swapFee, account,
    score: state ? totalScore(state) : 0,
    record: state ? callRecord(state) : { made: 0, right: 0 },
    ...actions,
  }), [ready, players, pool, state, error, teamOf, tierOf, account, actions]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
