import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  IconArrowsExchange,
  IconCalendarEvent,
  IconCards,
  IconGridDots,
  IconChartBar,
  IconExternalLink,
  IconFileText,
  IconHelp,
  IconMenu2,
  IconTrophy,
  IconUser,
} from '@tabler/icons-react';
import { useGame } from '../lib/gameContext';
import { playHome, showsPlayHome } from '../lib/playNavigation';
import HowTo from './HowTo';
import Sheet from './Sheet';
import AccountForm from './AccountForm';
import MatchDashboard from './MatchDashboard';
import useBingoUpdate from '../lib/useBingoUpdate';

const ICONS = {
  menu: IconMenu2,
  help: IconHelp,
  stats: IconChartBar,
  matches: IconCalendarEvent,
  rosters: IconArrowsExchange,
  bingo: IconGridDots,
  cards: IconCards,
  ranks: IconTrophy,
  legal: IconFileText,
  link: IconExternalLink,
  user: IconUser,
};
const Icon = ({ name, size = 22 }) => {
  const Component = ICONS[name];
  return <Component size={size} stroke={2} aria-hidden="true" />;
};

const TABS = [
  { to: '/play/collection', label: 'Cards', icon: 'cards' },
  { to: '/play/transfers', label: 'Transfers', icon: 'rosters' },
];

function Stats({ onDone }) {
  const { state, score, record, account } = useGame();
  if (!state) return <p className="note">Dealing your cards</p>;
  const pct = record.made ? Math.round((record.right / record.made) * 100) : 0;
  return (
    <>
      <div className="statgrid">
        <div><strong>{score}</strong><span>Points</span></div>
        <div><strong>{record.made}</strong><span>Calls</span></div>
        <div><strong>{pct}</strong><span>Right %</span></div>
        <div><strong>{state.streak}</strong><span>Streak</span></div>
      </div>
      <div className="statgrid">
        <div><strong>{state.credits}</strong><span>Credits</span></div>
        <div><strong>{state.collection.length}</strong><span>Cards</span></div>
        <div><strong>{state.packsOpened ?? 0}</strong><span>Packs</span></div>
        <div><strong>{state.freeSwaps}</strong><span>Free swaps</span></div>
      </div>
      {account.user && <Link className="secondary profile-link" to={`/u/${account.user.username}`} onClick={onDone}>Profile and past guesses</Link>}
    </>
  );
}

export default function Shell() {
  const location = useLocation();
  const { pathname } = location;
  const matches = showsPlayHome(location);
  const { state, score, devCredits, account } = useGame();
  const [sheet, setSheet] = useState(null);

  const { bingo, needsBingo } = useBingoUpdate(account.user?.username, pathname);
  const close = () => setSheet(null);

  if (!account.checked) return <main className="page"><p className="loading">Loading Play</p></main>;
  if (!account.user || account.recoveryCode) {
    return <main className="page"><div className="gate"><AccountForm onDone={close} /></div></main>;
  }

  return (
    <>
      <header className="hud play-hud">
        <button className="icon" aria-label="Game menu" onClick={() => setSheet('menu')}><Icon name="menu" /></button>
        <nav className="hud-tabs" aria-label="Play">
          <Link to={playHome} className={`hud-tab${matches ? ' on' : ''}`} aria-current={matches ? 'page' : undefined}>
            <Icon name="matches" size={18} />
            <span>Matches</span>
          </Link>
          {TABS.map(t => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => `hud-tab${isActive ? ' on' : ''}`}>
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
              {t.icon === 'cards' && state?.freePacks > 0 && <span className="tab-update" aria-label={`${state.freePacks} free packs available`}>{state.freePacks > 99 ? '99+' : state.freePacks}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="hud-right">
          {state && (
            <button className="chip" aria-label={`${score} points, ${state.credits} credits. Open stats`} onClick={() => setSheet('stats')}>
              <span><b>{score}</b> PTS</span>
              <span className="chip-cr"><b>{state.credits}</b> CR</span>
            </button>
          )}
          <button className="icon" aria-label="How to play" onClick={() => setSheet('help')}><Icon name="help" /></button>
        </div>
      </header>
      {import.meta.env.DEV && sessionStorage.getItem('opval-offline-preview') === '1' && <div className="offline-banner" role="status">Offline test account · Sample matches and standings · Reload to reset</div>}
      <main className={`page${matches ? ' page-dashboard' : ''}`}>
        <Outlet />
        {matches && <MatchDashboard bingo={bingo} needsBingo={needsBingo} />}
      </main>

      {account.notice && <button className="toast" role="status" onClick={account.clearNotice}>{account.notice}</button>}
      <Sheet open={sheet === 'menu'} onClose={close} title="Menu" side="left" head={<img className="menu-brand" src="/opval-logo.svg" alt="OpVAL" />}>
        <nav className="menu">
          <Link to="/play/leaderboard" onClick={close}><Icon name="ranks" />Leaderboard</Link>
          <Link to={`/u/${account.user.username}`} onClick={close}><Icon name="user" />Profile</Link>
          <Link to="/play/bingo" onClick={close}><Icon name="bingo" />Bingo</Link>
          <button onClick={() => setSheet('help')}><Icon name="help" />How to play</button>
          <button onClick={() => setSheet('stats')}><Icon name="stats" />Statistics</button>
          {import.meta.env.DEV && devCredits && <button onClick={() => { devCredits(1000); close(); }}><Icon name="stats" />Dev: +1000 credits</button>}
        </nav>
        <nav className="menu menu-minor" aria-label="About">
          <Link to="/legal" onClick={close}><Icon name="legal" />Legal</Link>
          <a href="https://www.vlr.gg" target="_blank" rel="noreferrer"><Icon name="link" />Match data: vlr.gg</a>
        </nav>
        <button className="secondary menu-out" onClick={async () => { await account.logout(); close(); }}>Sign out</button>
        <p className="menu-foot">Free fan game. No betting and no real money. Not endorsed by Riot Games.</p>
      </Sheet>
      <Sheet open={sheet === 'help'} onClose={close} title="How to play" size="guide"><HowTo onDone={close} /></Sheet>
      <Sheet open={sheet === 'stats'} onClose={close} title="Statistics"><Stats onDone={close} /></Sheet>
    </>
  );
}
