import { useState } from 'react';
import { useAccountApi } from '../lib/sessionContext';

// The title of a signed-out screen, with an optional line under it that belongs to the title.
const Head = ({ title, children }) => (
  <header className="account-head">
    <h2>{title}</h2>
    {children && <p>{children}</p>}
  </header>
);

function RecoveryCode({ code, onDone }) {
  const account = useAccountApi();
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {});
  return (
    <div className="account">
      <Head title="Save your recovery code">This code is the only way back into your account if you forget your password. We show it once, so save it now.</Head>
      <p className="code" aria-label="Recovery code">{code}</p>
      <button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy code'}</button>
      <button className="primary" onClick={() => { account.ackRecoveryCode(); onDone(); }}>I saved it</button>
    </div>
  );
}

export default function AccountForm({ onDone }) {
  const account = useAccountApi();
  const { user, login, signup, reset } = account;
  const [mode, setMode] = useState('login'); // login | signup | forgot
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = fn => async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setErr('');
    try { await fn(f); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const go = m => { setMode(m); setErr(''); };
  const error = err && <p className="form-error" role="alert">{err}</p>;

  if (account.recoveryCode) return <RecoveryCode code={account.recoveryCode} onDone={onDone} />;

  if (user) return <AccountSettings onDone={onDone} />;

  if (mode === 'forgot') {
    return (
      <form className="account" onSubmit={run(async f => { await reset({ username: f.username, code: f.code, password: f.password }); })}>
        <Head title="Reset password">Enter your username, the recovery code you saved at signup, and a new password.</Head>
        <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck="false" required maxLength={20} /></label>
        <label>Recovery code<input name="code" autoComplete="off" autoCapitalize="characters" spellCheck="false" required maxLength={24} placeholder="XXXX-XXXX-XXXX-XXXX" /></label>
        <label>New password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></label>
        {error}
        <button className="primary" disabled={busy}>Set new password</button>
        <button type="button" className="ghost" onClick={() => go('login')}>Back to sign in</button>
      </form>
    );
  }

  const signingUp = mode === 'signup';
  return (
    <form className="account" onSubmit={run(async f => { await (signingUp ? signup : login)({ username: f.username, password: f.password }); if (!signingUp) onDone(); })}>
      <Head title={signingUp ? 'Create account' : 'Sign in'} />
      <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck="false" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" /></label>
      <label>Password<input name="password" type="password" autoComplete={signingUp ? 'new-password' : 'current-password'} required minLength={signingUp ? 8 : 1} maxLength={128} /></label>
      {error}
      <button className="primary" disabled={busy}>{signingUp ? 'Create account' : 'Sign in'}</button>
      <button type="button" className="ghost" onClick={() => go(signingUp ? 'login' : 'signup')}>{signingUp ? 'Have an account? Sign in' : 'New here? Create account'}</button>
      {!signingUp && <button type="button" className="ghost" onClick={() => go('forgot')}>Forgot password?</button>}
    </form>
  );
}

// Signed in: the account's own controls. They live on your profile page, so there is one place for "you".
export function AccountSettings({ onDone, onSignOut = onDone }) {
  const account = useAccountApi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const makeCode = async e => {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get('password');
    setBusy(true); setErr('');
    try { await account.newCode(password); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  if (account.recoveryCode) return <RecoveryCode code={account.recoveryCode} onDone={onDone} />;
  return (
    <div className="account-settings">
      <form className="account" onSubmit={makeCode}>
        <p className="note">Lost your recovery code, or never got one? Make a new one. The old one stops working.</p>
        <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="secondary" disabled={busy}>New recovery code</button>
      </form>
      <button className="secondary" onClick={async () => { await account.logout(); onSignOut(); }}>Sign out</button>
    </div>
  );
}
