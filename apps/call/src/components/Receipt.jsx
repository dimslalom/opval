import { useRef, useState } from 'react';
import { toBlob } from 'html-to-image';
import { Face } from './Face';
import { colorsFor, logoFor, logoForName, tagForName } from '../lib/orgs';
import { TRANSFER, multiplierOf, payoutOf, pointsOf } from '../lib/transferBets';
import { CALL } from '../../../../src/engine/collect/rules';

const stamp = s => new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const serial = id => String(id).replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase().padStart(8, '0');

// Bars from the serial, so every receipt has its own (decorative, not scannable) barcode.
function Barcode({ id }) {
  const bits = [...serial(id)].flatMap(ch => { const n = ch.charCodeAt(0); return [1 + (n % 3), 1 + ((n >> 2) % 2), 1 + ((n >> 1) % 3), 1]; });
  return <div className="rc-barcode" aria-hidden="true">{bits.map((w, i) => <i key={i} style={{ flexGrow: w, opacity: i % 2 ? 0 : 1 }} />)}</div>;
}

// Legs come in move order (leave, then its join), so pair them back into moves for the picture.
const movesOf = legs => legs.reduce((out, leg) => {
  const last = out.at(-1);
  if (leg.type === 'join' && last && !last.join) last.join = leg; else out.push(leg.type === 'leave' ? { leave: leg } : { join: leg });
  return out;
}, []);

function RosterBody({ guess, settled }) {
  const hitsSoFar = guess.legs.filter(l => l.hit).length;
  const state = leg => (leg?.hit ? 'hit' : settled ? 'miss' : undefined);
  return <>
    <div className="rc-team">
      {logoForName(guess.team) && <img src={logoForName(guess.team)} alt="" />}
      <b>{guess.team}</b>
    </div>
    <div className="rc-moves">
      {movesOf(guess.legs).map((m, i) => <div key={i} className="rc-move">
        {m.leave && <Face player={m.leave.player} team={m.leave.team} scale={0.2} state={state(m.leave) ?? 'out'} />}
        <span className="rc-arrow" aria-hidden="true" />
        {m.join && <Face player={m.join.player} team={m.join.player === m.leave?.player ? m.leave.team : m.join.team} to={m.join.team} scale={0.2} state={state(m.join)} />}
      </div>)}
    </div>
    <ul className="rc-lines">
      {guess.legs.map((leg, i) => <li key={i} data-state={state(leg)}>
        <span>{leg.type === 'join' ? 'IN' : 'OUT'}</span><b>{leg.player}</b><i /><span>{leg.type === 'join' ? tagOf(leg.team) : tagOf(guess.team)}</span>
      </li>)}
    </ul>
    <dl className="rc-totals">
      {guess.stake == null ? <>
        <div><dt>Per right call</dt><dd>{TRANSFER.pointsPerLeg} PTS</dd></div>
        {settled
          ? <div className="rc-grand"><dt>Scored {hitsSoFar}/{guess.legs.length}</dt><dd>{guess.points} PTS</dd></div>
          : <div className="rc-grand"><dt>Max</dt><dd>{pointsOf(guess.legs.length)} PTS</dd></div>}
      </> : <>
        {/* Staked before guesses became points only: settles in credits, as placed. */}
        <div><dt>Stake</dt><dd>{guess.stake}</dd></div>
        <div><dt>All {guess.legs.length} hit</dt><dd>{multiplierOf(guess.legs.length)}x</dd></div>
        {settled
          ? <div className="rc-grand"><dt>Paid {hitsSoFar}/{guess.legs.length}</dt><dd>{guess.payout}</dd></div>
          : <div className="rc-grand"><dt>Max</dt><dd>{payoutOf(guess.stake, guess.legs.length, guess.legs.length)}</dd></div>}
      </>}
    </dl>
    {!settled && <p className="rc-due">Settles {stamp(guess.deadline)}</p>}
  </>;
}
const tagOf = name => tagForName(name) ?? name?.split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();

function MatchBody({ match, call, players }) {
  const star = call.star != null ? players?.[call.star] : null;
  return <>
    <div className="rc-match">
      {match.teams.map(t => <span key={t.tag} className="rc-side" data-picked={call.winner === t.tag} style={{ '--team': colorsFor(t.tag)[0] }}>
        {logoFor(t.tag) ? <img src={logoFor(t.tag)} alt="" /> : <span className="rc-mono">{t.tag}</span>}
        <b>{t.tag}</b>
      </span>)}
    </div>
    {call.score && <div className="rc-score" aria-label={`Score ${call.score[0]} to ${call.score[1]}`}><b>{call.score[0]}</b><i /><b>{call.score[1]}</b></div>}
    {star?.card && <div className="rc-star"><Face player={star.handle} card={star.card} scale={0.24} /></div>}
    <ul className="rc-lines">
      <li><span>WIN</span><b>{call.winner}</b><i /><span>+{CALL.winner}</span></li>
      {call.score && <li><span>MAP</span><b>{call.score.join('-')}</b><i /><span>+{CALL.exactScore}</span></li>}
      {star && <li><span>STAR</span><b>{star.handle}</b><i /><span>+{CALL.star}</span></li>}
    </ul>
    <dl className="rc-totals">
      <div className="rc-grand"><dt>Max</dt><dd>+{CALL.winner + (call.score ? CALL.exactScore : 0) + (star ? CALL.star : 0)}</dd></div>
    </dl>
    {match.startsAt && <p className="rc-due">Locks {stamp(match.startsAt)}</p>}
  </>;
}

// The shareable receipt for a guess: a roster guess (`guess`) or a match call (`match` + `call`).
export default function Receipt({ guess, match, call, players, username, placedAt, id }) {
  const paper = useRef(null);
  const [busy, setBusy] = useState(false);
  const [printedAt] = useState(() => Math.floor(Date.now() / 1000));
  const settled = guess?.settledAt != null;
  const kind = guess ? 'Roster guess' : 'Match call';
  const no = id ?? guess?.id ?? `${match?.matchId}${username ?? ''}`;
  const link = username ? `${location.origin}/u/${username}` : location.origin;

  const share = async () => {
    setBusy(true);
    try {
      const blob = await toBlob(paper.current, { pixelRatio: 2, cacheBust: true });
      const file = new File([blob], `opval-${serial(no)}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], url: link });
      else Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name }).click();
    } catch { /* share sheet dismissed */ } finally { setBusy(false); }
  };

  return <div className="rc-wrap">
    <article ref={paper} className="rc" data-kind={guess ? 'roster' : 'match'}>
      <header>
        <span className="rc-brand">Op<b>VAL</b></span>
        <span className="rc-kind">{kind}</span>
        <span className="rc-meta"><span>No. {serial(no)}</span><span>{stamp(guess?.placedAt ?? placedAt ?? printedAt)}</span></span>
      </header>
      {guess ? <RosterBody guess={guess} settled={settled} /> : <MatchBody match={match} call={call} players={players} />}
      <Barcode id={no} />
      <footer>{link.replace(/^https?:\/\//, '')}</footer>
    </article>
    <button type="button" className="primary big" onClick={share} disabled={busy}>{busy ? 'Printing' : 'Share'}</button>
  </div>;
}
