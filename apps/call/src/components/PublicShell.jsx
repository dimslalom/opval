import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { IconArrowsExchange, IconCalendarEvent, IconColumns, IconFlask, IconUser } from '@tabler/icons-react';
import { playHome, showsPlayHome } from '../lib/playNavigation';
import { useSession } from '../lib/sessionContext';
import SessionProvider from './SessionProvider';
import Sheet from './Sheet';
import AccountForm, { AccountSettings } from './AccountForm';

// Sign-in for the roster pages. Play has its own (it gates the game), so this hides there.
function AccountButton() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const user = session.user;
  return <div className="hud-right">
    <button type="button" className={user ? 'icon hud-account' : 'hud-signin'} aria-label={user ? `Account: ${user.username}` : undefined} onClick={() => setOpen(true)}>
      {user ? <IconUser size={20} stroke={2} aria-hidden="true" /> : 'Sign in'}
    </button>
    <Sheet open={open || Boolean(session.recoveryCode)} onClose={close} title={user && !session.recoveryCode ? user.username : 'Account'}>
      {user && !session.recoveryCode
        ? <div className="account-menu">
          <p className="note">Signed in as <b>{user.username}</b>. Saved lineups and share links live on your account.</p>
          <Link className="secondary" to="/saved" onClick={close}>Saved lineups</Link>
          <AccountSettings onDone={close} />
        </div>
        : <AccountForm onDone={close} />}
    </Sheet>
  </div>;
}

function Frame() {
  const location = useLocation();
  const { pathname } = location;
  const play = showsPlayHome(location) || /^\/(play|u)(\/|$)/i.test(pathname);
  const tabs = [
    { to: '/', label: 'Rosters', Icon: IconArrowsExchange, active: !play && (pathname === '/' || /^\/(teams|players)\//i.test(pathname)) },
    { to: '/compare', label: 'Compare', Icon: IconColumns, active: /^\/compare\/?$/i.test(pathname) },
    { to: '/sandbox', label: 'Sandbox', Icon: IconFlask, active: /^\/(sandbox|saved)\/?$/i.test(pathname) },
    { to: playHome, label: 'Play', Icon: IconCalendarEvent, active: play },
  ];
  const session = useSession();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname, play]);
  return (
    <div className="shell">
      <header className="hud">
        <Link className="hud-brand" to="/" aria-label="OpVAL rosters"><img src="/opval-logo.svg" alt="" /></Link>
        <nav className="hud-tabs" aria-label="Sections">
          {tabs.map(({ to, label, Icon, active }) => (
            <Link key={to} to={to} className={`hud-tab${active ? ' on' : ''}`} aria-current={active ? 'page' : undefined}>
              <Icon size={18} stroke={2} aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
        </nav>
        {!play && session.checked && <AccountButton />}
      </header>
      <Outlet />
      <footer className="public-foot">
        <span>Roster data from the Riot Games Global Contract Database.</span>
        <span>Fan project, not endorsed by Riot Games.</span>
        <Link to="/legal">Legal</Link>
      </footer>
    </div>
  );
}

export default function PublicShell() {
  return <SessionProvider><Frame /></SessionProvider>;
}
