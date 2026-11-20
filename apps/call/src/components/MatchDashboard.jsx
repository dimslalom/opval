import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useGame } from '../lib/gameContext';

export default function MatchDashboard({ bingo, needsBingo }) {
  const { state, account } = useGame();
  const [standings, setStandings] = useState(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let request = 0;
    const load = async () => {
      const ticket = ++request;
      try {
        const response = await fetch('/api/leaderboard?board=overall', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!controller.signal.aborted && ticket === request) { setStandings(data); setFailed(false); }
      } catch (error) { if (error.name !== 'AbortError' && ticket === request) setFailed(true); }
    };
    load();
    window.addEventListener('opval-save-synced', load);
    return () => { controller.abort(); window.removeEventListener('opval-save-synced', load); };
  }, [retry]);
  const packs = state?.freePacks ?? 0;
  const entries = standings?.entries.slice(0, 5) ?? [];
  const number = value => new Intl.NumberFormat().format(value ?? 0);
  return <aside className="match-dashboard" aria-label="Your game updates">
    <section className="dashboard-activity">
      <h2 className="section">Your next move</h2>
      <Link className="dashboard-update" data-ready={packs > 0} to="/play/collection">
        <div className="dashboard-update-top"><span className="dashboard-eyebrow">Cards</span></div>
        <div className="dashboard-update-title"><strong>{packs || state?.collection.length || 0}</strong><span>{packs ? `free pack${packs === 1 ? '' : 's'}` : 'cards collected'}{!packs && <small>{state?.tracked.length ?? 0} players tracked</small>}</span></div>
        <span className="dashboard-action secondary">{packs ? 'Open packs' : 'Manage cards'}<IconArrowUpRight size={15} aria-hidden="true" /></span>
      </Link>
      <Link className="dashboard-update" to="/play/bingo">
        <div className="dashboard-update-top"><span className="dashboard-eyebrow">Weekly bingo</span>{needsBingo && <span className="tab-update" aria-label="One selection needed">1</span>}</div>
        <div className="dashboard-bingo-preview" aria-hidden="true">{Array.from({ length: 4 }, (_, i) => <i key={i} data-filled={Boolean(bingo?.cards.length)}>{bingo?.cards.length ? '✓' : '+'}</i>)}</div>
        <strong className="dashboard-bingo-title">{needsBingo ? 'Make your four picks' : bingo?.cards.length ? 'Your card is in play' : 'This week’s bingo'}</strong>
        <span className="dashboard-action secondary">{needsBingo ? 'Pick your card' : 'View bingo'}<IconArrowUpRight size={15} aria-hidden="true" /></span>
      </Link>
    </section>
    <section className="dashboard-panel mini-leaderboard">
      <div className="dashboard-heading"><h2 className="section">Leaderboard</h2><span className="dashboard-eyebrow">Overall</span></div>
      {failed ? <p className="note">Standings aren't available right now. <button className="link" onClick={() => setRetry(n => n + 1)}>Try again</button></p> : !standings ? <p className="note" role="status">Loading standings…</p> : entries.length === 0 ? <p className="note">No scores yet. Reveal a finished match to enter.</p> : <>
        <ol>{entries.map(entry => <li key={entry.username} data-self={entry.username === account.user?.username}><span className="mini-rank">{entry.rank}</span><span className="mini-name">{entry.username}{entry.username === account.user?.username && <small> You</small>}</span><strong>{number(entry.points)}</strong></li>)}</ol>
        {standings.me && <div className="mini-own"><span>Your place <strong>{standings.me.rank ? `#${standings.me.rank}` : 'Unranked'}</strong></span><strong>{number(standings.me.points)} <small>PTS</small></strong></div>}
      </>}
      <Link className="dashboard-all" to="/play/leaderboard">Full leaderboard <IconArrowUpRight size={17} aria-hidden="true" /></Link>
    </section>
  </aside>;
}
