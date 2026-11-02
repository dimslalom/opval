import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconArrowRight, IconChevronLeft, IconChevronRight, IconClock, IconExternalLink, IconLock, IconPlus, IconSearch } from '@tabler/icons-react';
import Split from '../../../../shared/src/components/Split';
import Sheet from '../components/Sheet';
import { useGame } from '../lib/gameContext';
import { logoFor } from '../lib/orgs';
import { timeOf } from '../lib/time';
import { nextEditableWeek, weeklyById, MATCH_LEAD_TIME } from '../lib/weeklyBingo';

const blank = () => [null, null, null, null];
const sign = n => (n > 0 ? `+${n}` : String(n));
const RARE = 5;
const CALIBRATION_WEEKS = 4;
const CLUSTERS = [
  { id: 'close', label: 'Close map' },
  { id: 'stomp', label: 'Stomp' },
  { id: 'star', label: 'Star player' },
  { id: 'chaos', label: 'Chaos' },
  { id: 'agent', label: 'Agent' },
  { id: 'side', label: 'Side' },
  { id: 'roster', label: 'Roster moves' },
  { id: 'contract', label: 'Contracts' },
];
// What the card says: a short name per square. The exact rule (the square's label) shows in the picker.
const SHORT = {
  ot: 'Overtime', long24: 'Long map', k25: '25 kills', map3: 'Map 3',
  stomp8: '13-5 stomp', short20: 'Quick map', plus15: '+15 K/D',
  acs350: '350 ACS', k30: '30 kills', two20k: 'Two 20-bombs', mvpLoser: 'MVP loses',
  ace: 'Ace', c3: '1v3 clutch', c4: '1v4 clutch', minus12: '-12 K/D', fk6: '6 first kills', fk8: '8 first kills',
  duelistTop: 'Duelist MVP', controllerTop: 'Controller MVP', initiatorTop: 'Initiator MVP', sentinelTop: 'Sentinel MVP', yoruTop: 'Yoru MVP',
  def9: '9-round defense', atk9: '9-round attack',
  roster_add: 'Player joins', roster_depart: 'Player leaves', multi_team_change: 'Two teams move',
  contract_change: 'Contract changes', contract_extend: 'Contract extended', contract_shorten: 'Contract cut',
};
const nameOf = sq => SHORT[sq.id] ?? sq.label;
const dayOf = s => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekdayOf = s => new Date(s * 1000).toLocaleDateString(undefined, { weekday: 'short' });

// Time left as the two largest units: "2d 4h", "4h 12m", "38m".
function left(seconds) {
  const s = Math.max(0, seconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// A matchup as logo + tag per team, split by a hairline (never a typed separator).
const Tags = ({ match }) => <Split className="bteams" parts={[match.team1Tag, match.team2Tag].map(tag => {
  const logo = logoFor(tag);
  return <>{logo && <img src={logo} alt="" />}{tag || 'TBD'}</>;
})} />;
// "Any match this week": the week's teams as a row of logos, so the reach shows instead of being said.
function Crowd({ matches }) {
  if (!matches.length) return <span className="bcrowd bcrowd-empty">Any match</span>;
  const tags = [...new Set(matches.flatMap(m => [m.team1Tag, m.team2Tag]).filter(Boolean))];
  const shown = tags.slice(0, 5);
  return <span className="bcrowd" aria-label={`Any of ${matches.length} matches this week`}>
    {shown.map(tag => (logoFor(tag) ? <img key={tag} src={logoFor(tag)} alt="" /> : <i key={tag}>{tag}</i>))}
    {tags.length > shown.length && <small>+{tags.length - shown.length}</small>}
  </span>;
}

export default function Bingo() {
  const { account } = useGame();
  const [week, setWeek] = useState(() => nextEditableWeek(Math.floor(Date.now() / 1000)));
  const [data, setData] = useState(null);
  const [score, setScore] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [cells, setCells] = useState(blank);
  const [slot, setSlot] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(null);       // { i, square? }: which cell, and the square awaiting a match
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    const responses = await Promise.all(['', '/score'].map(p => fetch(`/api/weekly-bingo${p}?week=${week}`, { cache: 'no-store' })));
    fetch('/api/weekly-bingo/calibration', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(setCalibration).catch(() => {});
    if (responses.some(r => !r.ok)) throw new Error('Bingo is unavailable right now. Try again in a minute.');
    const [next, scored] = await Promise.all(responses.map(r => r.json()));
    setData(next);
    setScore(scored);
    setCells(next.cards.find(c => c.slot === slot)?.cells ?? blank());
  }, [week, slot]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => load()).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [load]);

  const saved = data?.cards.find(c => c.slot === slot);
  const full = cells.every(c => c?.square);
  const usedElsewhere = useMemo(() => new Set(data?.cards.filter(c => c.slot !== slot).flatMap(c => c.cells.map(x => x.square)) ?? []), [data, slot]);
  const result = score?.cards.find(c => c.slot === slot);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/weekly-bingo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week, slot, cells, version: saved?.version ?? 0 }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'The card was not saved.');
      await load();
      window.dispatchEvent(new Event('opval-wallet-changed'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!account.user) return <section className="bingo-page"><h1>Bingo</h1><p className="note">Sign in to play weekly bingo.</p></section>;
  const shift = by => setWeek(w => new Date(Date.parse(`${w}T00:00:00Z`) + by * 7 * 86400000).toISOString().slice(0, 10));
  const latest = nextEditableWeek(now);

  // The headline is whatever the week is waiting on: the lock, the end of play, or the results.
  const phase = !data ? null
    : data.settled ? { big: 'Final', small: 'Results are in' }
    : data.ended ? { big: 'Settling', small: 'Waiting on final results' }
    : { big: left(data.endsAt - now), small: 'Left this week' };
  // Seven pips for the week: played days fill, today is ruby; before lock they wait empty.
  const played = data ? Math.max(0, Math.min(7, Math.ceil((now - data.startsAt) / 86400))) : 0;
  const canAdd = data && !data.ended;
  const open = canAdd && !saved;
  const settledWeeks = Math.min(calibration?.settledWeeks ?? 0, CALIBRATION_WEEKS);

  const choose = (i, cell) => { setCells(prev => prev.map((c, n) => (n === i ? cell : c))); setPicking(null); setSearch(''); };
  const eligible = sq => (data?.matches ?? []).filter(m => m.startsAt >= now + MATCH_LEAD_TIME && (!sq.bestOf || m.bestOf === sq.bestOf));
  const pointsOf = cell => cell?.square && (saved?.catalog ?? data?.catalog)?.[cell.square]?.[cell.matchId == null ? 'general' : 'named'];
  const slots = data?.rules.paidEnabled
    ? Array.from({ length: Math.min(data.rules.maxCards, Math.max(1, data.cards.length + (canAdd ? 1 : 0))) }, (_, n) => n + 1)
    : [1];

  return <section className="bingo-page">
    <header className="bingo-head">
      <button type="button" className="icon" onClick={() => shift(-1)} aria-label="Previous week"><IconChevronLeft size={22} stroke={2.2} aria-hidden="true" /></button>
      <div className="bingo-phase" aria-live="polite">
        {phase && <strong aria-label={`${phase.big} ${phase.small}`}>{phase.big}</strong>}
        {data && <div className="bingo-week" aria-hidden="true">
          <span className="bingo-days">{Array.from({ length: 7 }, (_, n) => <i key={n} data-state={n < played - 1 || data.ended ? 'done' : n === played - 1 ? 'today' : undefined} />)}</span>
          <span className="bingo-dates"><small>{dayOf(data.startsAt)}</small><small>{dayOf(data.endsAt - 1)}</small></span>
        </div>}
      </div>
      <button type="button" className="icon" onClick={() => shift(1)} aria-label="Next week" disabled={week >= latest}><IconChevronRight size={22} stroke={2.2} aria-hidden="true" /></button>
    </header>

    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p className="note">Loading the week</p>}

    {data && <>
      <div className="tier-switch bingo-slots" role="group" aria-label="Cards" style={{ '--n': data.rules.paidEnabled ? slots.length : 2 }}>
        {slots.map(n => <button key={n} type="button" className={slot === n ? 'primary' : undefined} aria-pressed={slot === n}
          onClick={() => { setSlot(n); setCells(data.cards.find(c => c.slot === n)?.cells ?? blank()); }}>
          Card {n}{n > 1 && !data.cards.some(c => c.slot === n) && <small>{data.rules.cardCost} CR</small>}
        </button>)}
        {!data.rules.paidEnabled && <button type="button" disabled aria-label={`Card 2 opens after ${CALIBRATION_WEEKS} settled weeks, ${settledWeeks} so far`}>
          <IconLock size={14} stroke={2.2} aria-hidden="true" /><span className="bingo-pips" aria-hidden="true">{Array.from({ length: CALIBRATION_WEEKS }, (_, n) => <i key={n} data-on={n < settledWeeks} />)}</span>
        </button>}
      </div>

      <div className="bcard-grid bingo-card">
        {cells.map((cell, i) => {
          const sq = weeklyById[cell?.square];
          const out = result?.cells[i];
          const state = saved && out ? out.state : undefined;
          const match = cell?.matchId != null && data.matches.find(m => m.matchId === cell.matchId);
          const Cell = open ? 'button' : 'div';
          const pts = pointsOf(cell);
          return <Cell key={i} {...(open ? { type: 'button', onClick: () => { setSearch(''); setPicking({ i }); } } : {})}
            className="bcell" data-filled={!!sq} data-state={state}
            aria-label={open ? (sq ? `${nameOf(sq)}: ${sq.label}, ${pts} points. Change` : `Cell ${i + 1} empty. Pick a square`) : undefined}>
            {sq ? <>
              <span className="bcell-top">
                <span className="bcell-pts" data-rare={pts >= RARE}><b>{pts}</b><small>pts</small></span>
                {(state === 'pending' || state === 'free') && <span className="bcell-lock">{state}</span>}
              </span>
              <span className="bcell-label">{nameOf(sq)}</span>
              <span className="bcell-match">
                {sq.scope === 'roster' ? 'Riot GCD' : match ? <Tags match={match} /> : <Crowd matches={eligible(sq)} />}
                {state === 'hit' && out.evidence && <a href={out.evidence.sourceUrl ?? `https://www.vlr.gg/${out.evidence.matchId}`} target="_blank" rel="noreferrer" aria-label="Source"><IconExternalLink size={14} stroke={2.2} aria-hidden="true" /></a>}
              </span>
              {state && <span className="sr">{state}</span>}
            </> : open ? <span className="bcell-empty"><IconPlus size={22} stroke={2} aria-hidden="true" /></span> : <span className="bcell-empty">Empty</span>}
          </Cell>;
        })}
      </div>

      {open && <button type="button" className="primary big bingo-submit" onClick={save} disabled={busy || !full}>
        <IconLock size={18} stroke={2.2} aria-hidden="true" />{busy ? 'Locking' : 'Lock card'}
        {slot > 1 && <small className="bingo-cost">{data.rules.cardCost} CR</small>}
      </button>}
      {saved?.locked_at && <p className="bingo-locked"><IconLock size={15} stroke={2.2} aria-hidden="true" /><span className="sr">Locked</span>
        <Split parts={[weekdayOf(saved.locked_at), timeOf(saved.locked_at)]} /></p>}
      {result && saved && <p className="sum sum-total"><b>{sign(result.total)}</b><span>{result.complete ? 'this week' : 'so far'}</span></p>}
    </>}

    <Sheet open={picking != null} onClose={() => setPicking(null)}
      title={picking?.square ? weeklyById[picking.square].label : 'Pick a square'}
      head={picking?.square && <button type="button" className="icon bingo-back" aria-label="Back to squares" onClick={() => setPicking({ i: picking.i })}><IconChevronLeft size={22} stroke={2.2} aria-hidden="true" /></button>}>
      {picking && !picking.square && <label className="bingo-search">
        <IconSearch size={18} stroke={2} aria-hidden="true" />
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find an event" aria-label="Find a square" />
      </label>}
      {picking && !picking.square && CLUSTERS.map(cl => {
        const term=search.trim().toLocaleLowerCase();
        const list = (data?.squares ?? []).filter(s => s.cluster === cl.id && (!term || `${nameOf(s)} ${s.label} ${cl.label}`.toLocaleLowerCase().includes(term)));
        return list.length > 0 && <div key={cl.id} className="bingo-cluster">
          <h2 className="section">{cl.label}</h2>
          <ul>
            {list.map(s => {
              const inUse = usedElsewhere.has(s.id) || cells.some((c, n) => n !== picking.i && c?.square === s.id);
              const pts = data.catalog[s.id]?.general;
              return <li key={s.id}><button type="button" className="bsq" disabled={inUse}
                onClick={() => (s.scope === 'roster' ? choose(picking.i, { square: s.id, matchId: null }) : setPicking({ i: picking.i, square: s.id }))}>
                <span className="bsq-pts">
                  <span className="bcell-pts" data-rare={pts >= RARE}><b>{pts}</b><small>pts</small></span>
                  {!inUse && data.catalog[s.id]?.named > pts && <span className="bsq-more" data-rare={data.catalog[s.id].named >= RARE} aria-label={`${data.catalog[s.id].named} points for one named match`}><IconArrowRight size={13} stroke={2.4} aria-hidden="true" />{data.catalog[s.id].named}</span>}
                </span>
                <span className="bsq-label">{nameOf(s)}</span>
                <small className="bsq-rule">{s.label}</small>
                {inUse && <small className="bsq-note">In use</small>}
              </button></li>;
            })}
          </ul>
        </div>;
      })}
      {picking && !picking.square && search && !(data?.squares ?? []).some(s => `${nameOf(s)} ${s.label} ${CLUSTERS.find(c=>c.id===s.cluster)?.label??''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
        && <p className="bingo-picker-note">No squares found.</p>}
      {picking?.square && (() => {
        const sq = weeklyById[picking.square];
        const current = cells[picking.i];
        const soon = (data.matches ?? []).filter(m => m.startsAt > now && m.startsAt < now + MATCH_LEAD_TIME && (!sq.bestOf || m.bestOf === sq.bestOf));
        const options = [{ matchId: null, n: eligible(sq).length }, ...eligible(sq), ...soon.map(m => ({ ...m, soon: true }))];
        return <><p className="bingo-picker-note">{eligible(sq).length
          ? 'Pick any match, or name one for more points. Games starting within an hour cannot be named.'
          : 'No match is eligible yet. Any match can cover games listed later this week.'}</p><ul className="bingo-targets">
          {options.map(m => {
            const named = m.matchId != null && m.team1Tag !== undefined;
            const pts = data.catalog[sq.id][named ? 'named' : 'general'];
            const on = current?.square === sq.id && current.matchId === (named ? m.matchId : null);
            return <li key={m.matchId ?? 'any'}><button type="button" aria-pressed={on} disabled={m.soon} onClick={() => choose(picking.i, { square: sq.id, matchId: named ? m.matchId : null })}>
              <span className="bingo-target-what">
                {named ? <Tags match={m} /> : <b>Any match</b>}
                {named ? <small><Split parts={[weekdayOf(m.startsAt), timeOf(m.startsAt)]} /></small>
                  : m.n ? <Crowd matches={eligible(sq)} /> : <small>Future eligible games</small>}
              </span>
              {m.soon
                ? <span className="bingo-soon" aria-label={`Starts in ${left(m.startsAt - now)}, too soon to pick`}><IconClock size={15} stroke={2.2} aria-hidden="true" />{left(m.startsAt - now)}</span>
                : <span className="bcell-pts" data-rare={pts >= RARE}><b>{pts}</b><small>pts</small></span>}
            </button></li>;
          })}
        </ul></>;
      })()}
    </Sheet>
  </section>;
}
