import { createContext, useContext } from 'react';
import { useGame } from './gameContext';

// The public pages' sign-in (components/SessionProvider.jsx). Same shape as the game's account
// (lib/account.js), so AccountForm works with either.
export const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

// Inside the game, its account (which also syncs the save); elsewhere, the public session.
export function useAccountApi() {
  const game = useGame();
  const session = useSession();
  return game?.account ?? session;
}
