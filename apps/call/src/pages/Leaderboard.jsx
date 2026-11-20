import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGame } from '../lib/gameContext';
import { playHome } from '../lib/playNavigation';
import { weekKey } from '../lib/weeklyBingo';

const BOARDS = [
  { id: 'overall', label: 'Overall' },
  { id: 'calls', label: 'Calls' },
  { id: 'cards', label: 'Cards' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'bingo', label: 'Bingo' },
];
const number = value => new Intl.NumberFormat().format(value);

export default function Leaderboard() {
  const { account } = useGame();
  const [board, setBoard] = useState('overall');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async signal => {
    const ticket = ++request.current;
    setLoading(true);
    setError('');
    try {
      // Bingo ranks the week being played now; the other boards are all-time.
      const url = board === 'bingo' ? `/api/weekly-bingo/leaderboard?week=${weekKey(Math.floor(Date.now() / 1000))}` : `/api/leaderboard?board=${board}`;
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Standings are unavailable. Try again.');
      const next = await response.json();
      if (ticket === request.current) setData({ ...next, board });
    } catch (cause) {
      if (ticket === request.current && cause.name !== 'AbortError') setError(cause.message);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [board]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) load(controller.signal); });
    const refresh = () => load(controller.signal);
    window.addEventListener('opval-save-synced', refresh);
    return () => {
      request.current += 1;
      controller.abort();
      window.removeEventListener('opval-save-synced', refresh);
    };
  }, [load]);

  const shown = data?.board === board ? data : null;
  const listed = shown?.entries.some(entry => entry.username === account.user?.username);

  return <section className="leaderboard-page">
    <header className="leaderboard-head"><h1>Leaderboard</h1></header>
    <div className="leaderboard-switch" role="group" aria-label="Ranking by" style={{ '--n': BOARDS.length }}>
      {BOARDS.map(option => <button key={option.id} type="button" className={board === option.id ? 'primary' : undefined} aria-pressed={board === option.id} onClick={() => setBoard(option.id)}>{option.label}</button>)}
    </div>

    {error && <div className="leaderboard-message" role="alert"><p>{error}</p><button type="button" className="secondary" onClick={() => load()}>Try again</button></div>}
    {!error && !shown && <p className="leaderboard-message" role="status">{loading ? 'Loading standings' : 'No standings yet'}</p>}
    {!error && shown && shown.entries.length === 0 && <div className="leaderboard-empty">
      <strong>No scores yet</strong>
      <p>{board === 'bingo' ? 'Submit a weekly card to enter.' : 'Reveal a finished match to enter.'}</p>
      {board === 'bingo' ? <Link className="secondary" to="/play/bingo">Bingo</Link> : <Link className="secondary" to={playHome}>Matches</Link>}
    </div>}
    {!error && shown && shown.entries.length > 0 && <>
      <div className="leaderboard-columns" aria-hidden="true"><span>Player</span><span>Pts</span></div>
      <ol className="leaderboard-list">
        {shown.entries.map(entry => <li key={entry.username} className="leaderboard-entry" data-self={entry.username === account.user?.username}>
          <span className="leaderboard-rank">{entry.rank}</span>
          <span className="leaderboard-name">{entry.username}{entry.username === account.user?.username && <small>You</small>}</span>
          <strong className="leaderboard-points">{number(entry.points)}</strong>
        </li>)}
      </ol>
      {!listed && <div className="leaderboard-own">
        <span><small>Your place</small><b>{shown.me.rank ?? 'Unranked'}</b></span>
        <strong>{number(shown.me.points)} <small>PTS</small></strong>
      </div>}
    </>}
  </section>;
}
