import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { IconArrowsExchange, IconCalendarEvent, IconColumns, IconFlask } from '@tabler/icons-react';
import { playHome, showsPlayHome } from '../lib/playNavigation';

export default function PublicShell() {
  const location = useLocation();
  const { pathname } = location;
  const play = showsPlayHome(location) || /^\/(play|u)(\/|$)/i.test(pathname);
  const tabs = [
    { to: '/', label: 'Rosters', Icon: IconArrowsExchange, active: !play && (pathname === '/' || /^\/(teams|players)\//i.test(pathname)) },
    { to: '/compare', label: 'Compare', Icon: IconColumns, active: /^\/compare\/?$/i.test(pathname) },
    { to: '/sandbox', label: 'Sandbox', Icon: IconFlask, active: /^\/sandbox\/?$/i.test(pathname) },
    { to: playHome, label: 'Play', Icon: IconCalendarEvent, active: play },
  ];
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
