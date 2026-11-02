import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconContract } from '@tabler/icons-react';
import Sheet from './Sheet';
import { Crest, Face } from './Face';
import Receipt from './Receipt';
import { colorsFor, tagForName } from '../lib/orgs';
import { assetPath } from '../../../../shared/src/lib/utils';
import { searchCards, suggestCards } from '../lib/rosterCards';
import { glassVars } from '../lib/ink';
import { identityOf, multiplierOf, payoutOf } from '../lib/transferBets';

const yearOf = end => Number(String(end ?? '').match(/20\d\d/)?.[0]) || null;
const STAKES = [10, 50, 100, 250, 500];

// One player's move: who replaces them, or which team they leave for. Before anyone types it already
// offers the likely answers: the best cards from the team's region, and the teams in its league.
function MovePicker({ player, team, league, leagueOf, onPick, onClear, current }) {
  const [mode, setMode] = useState(current?.to ? 'to' : current?.in ? 'in' : null);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const cards = useMemo(() => (mode !== 'in' ? [] : q ? searchCards(q, 12) : suggestCards(league, team, 8)), [mode, q, league, team]);
  const teams = useMemo(() => (mode !== 'to' ? [] : [...leagueOf.keys()]
    .filter(t => t !== team && t.toLowerCase().includes(q))
    .sort((a, b) => (leagueOf.get(b) === league) - (leagueOf.get(a) === league) || a.localeCompare(b))), [mode, q, leagueOf, league, team]);
  const choose = next => { setMode(next); setQuery(''); };

  return <div className="picker">
    <div className="picker-modes" role="radiogroup" aria-label={`${player}'s move`}>
      <button type="button" role="radio" aria-checked={mode === 'in'} aria-pressed={mode === 'in'} onClick={() => choose('in')}>
        <span className="picker-glyph" aria-hidden="true">
          <Face player={player} team={team} scale={0.09} state="out" /><i className="picker-arrow" />
          <img className="pface-q" src={assetPath('/assets/card-bg/empty-card.png')} alt="" />
        </span>
        <b>Replaced by</b>
      </button>
      <button type="button" role="radio" aria-checked={mode === 'to'} aria-pressed={mode === 'to'} onClick={() => choose('to')}>
        <span className="picker-glyph" aria-hidden="true">
          <Face player={player} team={team} scale={0.09} /><i className="picker-arrow" /><span className="crest-q" />
        </span>
        <b>Leaving for</b>
      </button>
    </div>

    {mode && <input className="picker-search" autoFocus value={query} onChange={e => setQuery(e.target.value)}
      placeholder={mode === 'in' ? `Who replaces ${player}?` : `Where does ${player} go?`} aria-label={mode === 'in' ? 'Search players' : 'Search teams'} />}

    {mode === 'in' && <div className="picker-cards">
      {cards.map(c => <Face key={c.id} player={c.player} card={c} scale={0.17} onClick={() => onPick({ in: c.player, card: c })} />)}
      {q.length > 1 && !cards.length && <button type="button" className="pface-blank picker-free" onClick={() => onPick({ in: query.trim() })}
        style={{ width: 68, height: 99, fontSize: 11, '--team': colorsFor(tagForName(team))[0] }}><Crest name={team} size={30} /><b>{query.trim()}</b></button>}
    </div>}

    {mode === 'to' && <div className="picker-teams">
      {teams.map(t => <button key={t} type="button" onClick={() => onPick({ to: t })} data-near={leagueOf.get(t) === league} style={{ '--team': colorsFor(tagForName(t))[0] }}>
        <Crest name={t} size={38} /><small>{t}</small>
      </button>)}
    </div>}

    {current && <button type="button" className="picker-keep" onClick={onClear}>Keep {player} on {tagForName(team) ?? team}</button>}
  </div>;
}

// The picker as a popover anchored to the tapped card, with a pointer at it: below the card, or above
// when the card sits low. Clicking outside or Esc closes it; Esc is stopped so the sheet stays open.
function Popover({ anchor, onClose, color, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = e => { if (!ref.current?.contains(e.target) && !anchor.el.contains(e.target)) onClose(); };
    // The popover is pinned to where the card was, so scrolling the sheet closes it rather than leaving it behind.
    const scrolled = e => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('scroll', scrolled, true); };
  }, [anchor, onClose]);
  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);
  const r = anchor.rect;
  const width = Math.min(360, innerWidth - 16);
  const left = Math.max(8, Math.min(innerWidth - width - 8, r.left + r.width / 2 - width / 2));
  const below = r.top + r.height / 2 < innerHeight * 0.5;
  const tip = Math.max(22, Math.min(width - 22, r.left + r.width / 2 - left));
  return <div ref={ref} className="move-pop" role="dialog" aria-label="Move" data-side={below ? 'below' : 'above'}
    style={{ left, width, '--tip': `${tip}px`, ...glassVars(color), ...(below ? { top: r.bottom + 10 } : { bottom: innerHeight - r.top + 10 }) }}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    {children}
  </div>;
}

// The largest card scale at which every card fits the box, trying 1 to 3 rows, so the sheet never scrolls.
const GAP_X = 22, GAP_Y = 18, LABEL = 30;
function useFitScale(ref, count) {
  const [fit, setFit] = useState({ scale: 0.3, per: count });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !count) return undefined;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      let best = { scale: 0, per: count };
      for (let rows = 1; rows <= Math.min(3, count); rows++) {
        const per = Math.ceil(count / rows);
        const scale = Math.min((width - GAP_X * per) / per / 400, (height - (GAP_Y + LABEL) * rows) / rows / 580);
        if (scale > best.scale) best = { scale, per };
      }
      setFit({ scale: Math.max(0.12, Math.min(0.42, best.scale)), per: best.per });
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, count]);
  return fit;
}

// Contract end as a picture: a track of years from now, filled up to the year the deal ends.
function ContractTrack({ player, team, end, thisYear, years = 4 }) {
  const tip = end ? `${player}'s contract with ${team} ends with the ${end} season${end === thisYear ? ': free to move this offseason.' : '.'}` : 'Contract end not listed on Riot GCD';
  return <span className="contract" data-ending={end === thisYear} tabIndex={0} data-tip={tip} aria-label={tip}>
    <IconContract size={15} stroke={2} aria-hidden="true" />
    <span className="contract-track" aria-hidden="true">{Array.from({ length: years }, (_, i) => <i key={i} data-on={end != null && thisYear + i <= end} data-end={thisYear + i === end} />)}</span>
    <small aria-hidden="true">{end ? `'${String(end).slice(2)}` : '?'}</small>
  </span>;
}

// A team's roster as cards. Tap a card to guess its move; the card changes jersey to show it.
export function TeamSheet({ team, contracts, guessing, onClose, onPlaced, signedIn, username }) {
  const leagueOf = useMemo(() => new Map(contracts.map(c => [c.team, c.league])), [contracts]);
  const roster = contracts.filter(c => c.team === team).map(c => ({ ...c, key: identityOf(c.player, c.league) }));
  const [moves, setMoves] = useState({});
  const [picking, setPicking] = useState(null);
  const [stake, setStake] = useState(() => Math.min(50, STAKES.filter(v => v <= (guessing?.balance ?? 50)).at(-1) ?? STAKES[0]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);
  const color = colorsFor(tagForName(team))[0];
  const thisYear = new Date().getUTCFullYear();

  const list = Object.entries(moves);
  const legs = list.reduce((n, [, m]) => n + (m.in || m.to ? 2 : 0), 0);
  const balance = guessing?.balance ?? 0;
  const canLock = signedIn && guessing?.lock && legs > 0 && stake <= balance && !busy;
  const who = picking && roster.find(p => p.key === picking.key);
  const pick = key => e => setPicking({ key, el: e.currentTarget, rect: e.currentTarget.getBoundingClientRect() });
  const multiplier = multiplierOf(legs);
  const cardsRef = useRef(null);
  const { scale, per } = useFitScale(cardsRef, roster.length);
  const short = signedIn && stake > balance;

  const lock = async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/transfer-bets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stake, moves: list.map(([out, m]) => (m.in ? { out, in: m.in } : { out, to: m.to })) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not lock in the guess');
      window.dispatchEvent(new Event('opval-wallet-changed'));
      setPlaced(data.bet);
      onPlaced(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return <Sheet open onClose={onClose} title={team} size="full" style={{ '--team': color }}
    head={<span className="team-hero"><Crest name={team} size={40} /><b>{team}</b></span>}>
    {placed ? <Receipt guess={placed} username={username} /> : <>
      <div className="team-cards" ref={cardsRef}>
        <div className="team-cards-rows" style={{ gap: `${GAP_Y}px ${GAP_X}px`, maxWidth: per * (400 * scale + GAP_X) }}>
        {roster.map(p => {
          const m = moves[p.key];
          const end = yearOf(p.contractEnd);
          // Replaced: the old card stays in the slot, greyed and pushed back behind the new one.
          return <div key={p.key} className="team-slot" data-move={m?.in ? 'in' : m?.to ? 'to' : undefined}>
            <span className="slot-stack">
              {m?.in && <span className="slot-behind" aria-hidden="true"><Face player={p.player} team={team} scale={scale} state="out" /></span>}
              {m?.in ? <Face key={m.in} player={m.in} card={m.card} team={team} scale={scale} onClick={pick(p.key)} />
                : m?.to ? <Face key={m.to} player={p.player} team={team} to={m.to} scale={scale} onClick={pick(p.key)} />
                : <Face player={p.player} team={team} scale={scale} onClick={pick(p.key)} />}
            </span>
            <ContractTrack player={p.player} team={team} end={end} thisYear={thisYear} />
          </div>;
        })}
        </div>
      </div>

      <footer className="guess-bar" data-ready={legs > 0}>
        <div className="tier-switch guess-stake" role="group" aria-label="Stake in credits" style={{ '--n': STAKES.length }}>
          {STAKES.map(s => <button key={s} type="button" className={stake === s ? 'primary' : undefined} aria-pressed={stake === s} disabled={signedIn && s > balance} onClick={() => setStake(s)}>{s}</button>)}
        </div>
        <div className="guess-win" tabIndex={0} data-tip={legs
          ? `${legs} calls: each player out, each player in. All ${legs} right pays ${multiplier}x your stake; each right call pays its share.`
          : 'Tap a card to guess who replaces them or where they go.'}>
          <small>{legs ? `${multiplier}x` : 'Payout'}</small><b>{legs ? payoutOf(stake, legs, legs) : 0}</b>
        </div>
        <button type="button" className="primary big" disabled={!canLock} onClick={lock}>{!signedIn ? 'Sign in to guess' : short ? `${balance} CR left` : busy ? 'Locking' : 'Lock in'}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </footer>
    </>}

    {who && <Popover anchor={picking} color={color} onClose={() => setPicking(null)}>
      <MovePicker key={who.key} player={who.player} team={team} league={who.league} leagueOf={leagueOf} current={moves[who.key]}
        onPick={m => { setMoves(all => ({ ...all, [who.key]: m })); setPicking(null); }}
        onClear={() => { setMoves(all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== who.key))); setPicking(null); }} />
    </Popover>}
  </Sheet>;
}

// The player's guesses, newest first, each a tap away from its receipt.
export function GuessStrip({ guesses, onOpen }) {
  return <ul className="guess-strip">
    {guesses.map(g => {
      const hits = g.legs.filter(l => l.hit).length;
      return <li key={g.id}><button type="button" onClick={() => onOpen(g)}>
        <Crest name={g.team} size={36} />
        <span className="guess-faces" aria-hidden="true">{g.legs.filter(l => l.type === 'join').map((l, i) => <Face key={i} player={l.player} team={l.team} scale={0.11} state={l.hit ? 'hit' : g.settledAt != null ? 'miss' : undefined} />)}</span>
        <span className="guess-pips" aria-label={`${hits} of ${g.legs.length} legs hit`}>{g.legs.map((l, i) => <i key={i} data-hit={l.hit} data-type={l.type} />)}</span>
        <b>{g.settledAt != null ? g.payout : payoutOf(g.stake, g.legs.length, g.legs.length)}</b>
      </button></li>;
    })}
  </ul>;
}
