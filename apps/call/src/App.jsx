import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LayoutGroup, LazyMotion, MotionConfig } from 'motion/react';
import Shell from './components/Shell';
import { GameProvider } from './lib/game';

const Today = lazy(() => import('./pages/Today'));
const Collection = lazy(() => import('./pages/Collection'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Bingo = lazy(() => import('./pages/Bingo'));
const Roster = lazy(() => import('./pages/Roster'));
const Legal = lazy(() => import('./pages/Legal'));
const Profile = lazy(() => import('./pages/Profile'));

// PlayerCard (shared with the old site) animates with the `m` namespace under a
// strict LazyMotion, so the same providers wrap this app.
const loadFeatures = () => import('../../../shared/src/lib/motionFeatures').then(mod => mod.default);

export default function App() {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">
        <LayoutGroup>
          <GameProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<Suspense fallback={<p className="loading">Loading</p>}><Today /></Suspense>} />
                <Route path="collection" element={<Suspense fallback={<p className="loading">Loading</p>}><Collection /></Suspense>} />
                <Route path="leaderboard" element={<Suspense fallback={<p className="loading">Loading</p>}><Leaderboard /></Suspense>} />
                <Route path="roster" element={<Suspense fallback={<p className="loading">Loading</p>}><Roster /></Suspense>} />
                <Route path="bingo" element={<Suspense fallback={<p className="loading">Loading</p>}><Bingo /></Suspense>} />
                <Route path="u/:username" element={<Suspense fallback={<p className="loading">Loading</p>}><Profile /></Suspense>} />
                <Route path="legal" element={<Suspense fallback={<p className="loading">Loading</p>}><Legal /></Suspense>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </GameProvider>
        </LayoutGroup>
      </MotionConfig>
    </LazyMotion>
  );
}
