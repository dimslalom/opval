import { Children, useEffect, useRef, useState } from 'react';
import { fetchMatch } from '../lib/feed';
import { useGame } from '../lib/gameContext';
import { assetPath, thumbnailSrc } from '../../../../shared/src/lib/utils';
import { colorsFor, logoFor } from '../lib/orgs';
import CallPanel from './CallPanel';
import Fan from './Fan';
import { CallSummary, MatchHead, MatchHero, MatchStrip } from './MatchFacts';
import Sheet from './Sheet';
import Receipt from './Receipt';

// A player's cutout portrait, bare on the card (no tile), or nothing when the card has no image.
function Face({ player }) {
  const image = player && thumbnailSrc(player.card);
  return image ? <img className="face" src={assetPath(image)} alt="" loading="lazy" /> : null;
}

// Side-by-side pages that snap on swipe (your call, then your cards), with dots to show where
// you are and to click across without a touch screen. One page renders plain.
function Swipe({ children }) {
  const pages = Children.toArray(children);
  const track = useRef(null);
  const [at, setAt] = useState(0);
  const [height, setHeight] = useState();
  // The strip takes the height of the page you are on, so a short page leaves no gap above the dots.
  useEffect(() => {
    const page = track.current?.children[at];
    if (!page) return undefined;
    const watch = new ResizeObserver(() => setHeight(page.offsetHeight));
    watch.observe(page);
    return () => watch.disconnect();
  }, [at, pages.length]);
  if (pages.length < 2) return pages;
  const go = i => track.current.scrollTo({ left: track.current.children[i].offsetLeft, behavior: 'smooth' });
  return (
    <div className="swipe">
      <div className="swipe-track" ref={track} style={{ height }} onScroll={e => setAt(Math.round((e.currentTarget.scrollLeft / e.currentTarget.scrollWidth) * pages.length))}>
        {pages.map(page => <div className="swipe-page" key={page.key}>{page}</div>)}
      </div>
      <div className="swipe-dots">
        {pages.map((page, i) => <button key={page.key} aria-label={`Page ${i + 1} of ${pages.length}`} aria-current={at === i} onClick={() => go(i)}><i /></button>)}
      </div>
    </div>
  );
}

function TeamRow({ team, score, win, dim }) {
  const logo = logoFor(team.tag);
  return (
    <div className="team" data-org={team.tag} data-win={win} data-dim={dim}>
      {logo ? <img className="logo" src={logo} alt="" loading="lazy" /> : <span className="logo mono">{(team.tag || team.name || '?').slice(0, 3)}</span>}
      <strong className="tag">{team.tag || team.name}</strong>
      <span className="name">{team.name !== team.tag && team.name}</span>
      {score != null && <span className="score">{score}</span>}
    </div>
  );
}

const sign = n => (n > 0 ? `+${n}` : String(n));

// One real series. Upcoming: call it. Started: your call is locked. Finished: spoiler-guarded
// until you reveal it, then it shows the result and exactly how your call and Tracked cards scored.
export default function MatchCard({ match, eventLabel, now }) {
  const { state, players, account, call: setCall, reveal } = useGame();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [printed, setPrinted] = useState(false);

  const [a, b] = match.teams;
  const started = match.status !== 'upcoming' || (match.startsAt && match.startsAt <= now);
  const live = match.status === 'live' || (match.status === 'upcoming' && started);
  const done = match.status === 'final';
  const report = state?.revealed[match.matchId];
  const guarded = done && (!report || report.unseen);
  const myCall = state?.calls[match.matchId];
  const pickedSide = myCall?.winner === a.tag ? 'left' : myCall?.winner === b.tag ? 'right' : undefined;
  const leftColors = colorsFor(a.tag);
  const rightColors = colorsFor(b.tag);
  const winnerIdx = done && !guarded ? (match.winner ?? 0) - 1 : -1;

  const doReveal = async () => {
    setBusy(true);
    setFailed(false);
    const detail = await fetchMatch(match.matchId);
    if (detail && await reveal(detail)) { setBusy(false); return; }
    setBusy(false);
    setFailed(true);
  };

  return (
    <article className="match" data-status={live ? 'live' : match.status}>
      <MatchStrip match={match} eventLabel={eventLabel} now={now} live={live} />

      <div className="teams">
        <TeamRow team={a} score={report && !guarded ? a.score : null} win={winnerIdx === 0} dim={winnerIdx === 1} />
        <TeamRow team={b} score={report && !guarded ? b.score : null} win={winnerIdx === 1} dim={winnerIdx === 0} />
      </div>

      {!started && state && (
        <div className="callwrap">
          <button className="callbtn" data-called={Boolean(myCall?.winner)} onClick={() => setOpen(true)}>
            {myCall?.winner ? <CallSummary call={myCall} players={players} /> : <span className="callsum-none">No call yet</span>}
            <span className="callbtn-go">{myCall?.winner ? 'Edit' : 'Make call'} <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg></span>
          </button>
          <Sheet open={open} onClose={() => { setOpen(false); setPrinted(false); }} title={`${a.tag} vs ${b.tag}`} head={<MatchHead match={match} now={now} live={live} />} size="full" pickedSide={pickedSide} style={{
            '--team-left-1': leftColors[0], '--team-left-2': leftColors[1] ?? leftColors[0], '--team-left-3': leftColors[2] ?? leftColors[0],
            '--team-right-1': rightColors[0], '--team-right-2': rightColors[1] ?? rightColors[0], '--team-right-3': rightColors[2] ?? rightColors[0],
          }}>
            {printed && myCall?.winner ? <Receipt match={match} call={myCall} players={players} username={account.user?.username} /> : <>
              <MatchHero match={match} eventLabel={eventLabel} />
              <CallPanel match={match} call={myCall} players={players} tracked={state.tracked} onChange={c => setCall(match.matchId, c)} />
              <div className="call-commit">
                {myCall?.winner && <span className="call-saved">Saved</span>}
                <button className="primary big" onClick={() => (myCall?.winner ? setPrinted(true) : setOpen(false))}>Done</button>
              </div>
            </>}
          </Sheet>
        </div>
      )}

      {started && !done && (
        <div className="locked"><small>Locked</small>{myCall?.winner ? <CallSummary call={myCall} players={players} /> : <span className="callsum-none">No call made</span>}</div>
      )}

      {guarded && (
        <button className="reveal" onClick={doReveal} disabled={busy} aria-busy={busy}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 3l18 18" /><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a12.6 12.6 0 0 1-2.6 3.3M6.5 7.7A12.7 12.7 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.6 9.6 0 0 0 3.2-.6" />
          </svg>
          {busy ? 'Revealing' : 'Reveal result'}
        </button>
      )}
      {failed && <p className="error">Could not load the result. Try again.</p>}

      {report && !guarded && (
        <div className="result">
          {report.preJoin && <p className="muted">Played before you joined, so it does not score.</p>}
          {!report.preJoin && (
            <>
              <Swipe>
                {report.call ? (
                  <section className="result-part">
                    {/* Each part is headed by what it earned. Alone, the call needs no heading: the total says it. */}
                    {report.trackedLines.length > 0 && <h3 className="sum"><b>{sign(report.callPoints)}</b><span>from your call</span></h3>}
                    <ul className="verdict">
                      <li data-ok={report.result.winnerRight}>
                        <small>Winner</small>
                        <span className="verdict-art">{logoFor(report.call.winner) ? <img src={logoFor(report.call.winner)} alt="" /> : <b>{report.call.winner}</b>}</span>
                        <b className="verdict-name">{report.call.winner}</b>
                        <span className="sr-only">{report.result.winnerRight ? 'Right' : 'Miss'}</span>
                      </li>
                      {report.call.score && (
                        <li data-ok={report.result.scoreRight}>
                          <small>Score</small>
                          <span className="verdict-art"><b>{report.call.score[0]}-{report.call.score[1]}</b></span>
                          <span className="sr-only">{report.result.scoreRight ? 'Right' : 'Miss'}</span>
                        </li>
                      )}
                      {report.call.star && (
                        <li className="verdict-star" data-ok={report.result.starRight}>
                          <small>Star</small>
                          <span className="verdict-art verdict-face"><Face player={players[report.call.star]} /></span>
                          <b className="verdict-name">{players[report.call.star]?.handle ?? report.call.star}</b>
                          <span className="sr-only">{report.result.starRight ? 'Right' : 'Miss'}</span>
                        </li>
                      )}
                    </ul>
                  </section>
                ) : <p className="muted">No call on this one.</p>}
                {report.trackedLines.length > 0 && (
                  <section className="result-part">
                    <h3 className="sum"><b>{sign(report.trackedLines.reduce((n, l) => n + l.total, 0))}</b><span>from your cards</span></h3>
                    {/* Your Tracked cards as a hand, best scorer in the middle, each tagged with its points. */}
                    <Fan
                      pids={[...report.trackedLines].filter(l => players[l.pid]?.card).sort((x, y) => y.total - x.total).map(l => l.pid)}
                      cardOf={pid => players[pid].card}
                      scale={0.24}
                      arc={2}
                      tagOf={pid => ({ label: sign(report.trackedLines.find(l => l.pid === pid).total) })}
                    />
                  </section>
                )}
              </Swipe>
              <p className="sum sum-total"><b>{sign(report.total)}</b><span>this match</span></p>
            </>
          )}
        </div>
      )}

    </article>
  );
}
