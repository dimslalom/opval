import { useCallback, useEffect, useMemo, useState } from 'react';
import { AUTH_EVENT, api } from '../lib/account';
import { SessionContext } from '../lib/sessionContext';

// Sign-in for the public roster pages, without loading the game. Same endpoints as the game's
// account; each side announces sign-in and sign-out with AUTH_EVENT, so the other catches up.
const announce = () => window.dispatchEvent(new Event(AUTH_EVENT));

export default function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(null);

  useEffect(() => {
    const me = () => api('GET', '/api/auth/me').then(d => setUser(u => (u?.username === d.user?.username ? u : d.user)), () => {}).finally(() => setChecked(true));
    me();
    window.addEventListener(AUTH_EVENT, me);
    return () => window.removeEventListener(AUTH_EVENT, me);
  }, []);

  const enter = useCallback(path => async fields => {
    const d = await api('POST', path, fields);
    setUser(d.user);
    if (d.recoveryCode) setRecoveryCode(d.recoveryCode);
    announce();
  }, []);
  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout', {}).catch(() => {});
    setUser(null);
    setRecoveryCode(null);
    announce();
  }, []);

  const value = useMemo(() => ({
    user, checked, recoveryCode, ackRecoveryCode: () => setRecoveryCode(null),
    signup: enter('/api/auth/signup'),
    login: enter('/api/auth/login'),
    reset: enter('/api/auth/reset'),
    newCode: async password => setRecoveryCode((await api('POST', '/api/auth/recovery', { password })).recoveryCode),
    logout,
  }), [user, checked, recoveryCode, enter, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
