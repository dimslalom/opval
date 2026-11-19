import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutGroup, LazyMotion, MotionConfig } from 'motion/react';
import Shell from './components/Shell';
import PublicShell from './components/PublicShell';
import { GameProvider } from './lib/game';
import { showsPlayHome } from './lib/playNavigation';

const Today = lazy(() => import('./pages/Today'));
const Collection = lazy(() => import('./pages/Collection'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Bingo = lazy(() => import('./pages/Bingo'));
const Roster = lazy(() => import('./pages/Roster'));
const Legal = lazy(() => import('./pages/Legal'));
const Profile = lazy(() => import('./pages/Profile'));
const Rosters = lazy(() => import('./pages/Rosters'));
const Team = lazy(() => import('./pages/Team'));
const Player = lazy(() => import('./pages/Player'));
const Compare = lazy(() => import('./pages/Compare'));

// PlayerCard (shared with the old site) animates with the `m` namespace under a
// strict LazyMotion, so the same providers wrap this app.
const loadFeatures = () => import('../../../shared/src/lib/motionFeatures').then(mod => mod.default);
const page = el => <Suspense fallback={<p className="loading">Loading</p>}>{el}</Suspense>;

function RosterHomeOrPlay() {
  const location = useLocation();
  if (location.pathname === '/' && !showsPlayHome(location)) {
    return <main className="page">{page(<Rosters />)}</main>;
  }
  return <GameProvider><Shell /></GameProvider>;
}

function PublicPage() {
  return <main className="page"><Outlet /></main>;
}

function LegacyPlay() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set('view', 'play');
  return <Navigate to={`/?${params}${hash}`} replace />;
}

export default function App() {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">
        <LayoutGroup>
          <BrowserRouter>
            <Routes>
              <Route element={<PublicShell />}>
                <Route element={<PublicPage />}>
                  <Route path="teams/:teamId/:slug?" element={page(<Team />)} />
                  <Route path="players/:personId/:slug?" element={page(<Player />)} />
                  <Route path="compare" element={page(<Compare />)} />
                  <Route path="legal" element={page(<Legal />)} />
                </Route>
                <Route path="play" element={<LegacyPlay />} />
                <Route element={<RosterHomeOrPlay />}>
                  <Route index element={page(<Today />)} />
                  <Route path="play/collection" element={page(<Collection />)} />
                  <Route path="play/leaderboard" element={page(<Leaderboard />)} />
                  <Route path="play/transfers" element={page(<Roster />)} />
                  <Route path="play/bingo" element={page(<Bingo />)} />
                  <Route path="u/:username" element={page(<Profile />)} />
                </Route>
              </Route>
              <Route path="roster" element={<Navigate to="/" replace />} />
              <Route path="collection" element={<Navigate to="/play/collection" replace />} />
              <Route path="leaderboard" element={<Navigate to="/play/leaderboard" replace />} />
              <Route path="bingo" element={<Navigate to="/play/bingo" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </LayoutGroup>
      </MotionConfig>
    </LazyMotion>
  );
}
