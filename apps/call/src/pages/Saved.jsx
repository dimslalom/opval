import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/sessionContext';
import { loadDrafts, newId, saveDrafts } from '../lib/drafts';
import { deleteWorkspace, draftFrom, getWorkspace, listShares, listWorkspaces, revokeShare } from '../lib/workspaces';
import { rosterDay } from '../lib/time';

function Shares({ id, onChange }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => listShares(id).then(d => setShares(d.shares), e => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const revoke = async shareId => { try { await revokeShare(id, shareId); await load(); onChange(); } catch (e) { setError(e.message); } };
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!shares) return <p className="note">Loading links</p>;
  if (!shares.length) return <p className="note">No links yet. Make one from the sandbox.</p>;
  return <ul className="saved-shares">
    {shares.map(s => <li key={s.id} data-revoked={Boolean(s.revokedAt)}>
      <span>Made {rosterDay(s.createdAt)}, version {s.revision}</span>
      {s.revokedAt ? <span>Revoked {rosterDay(s.revokedAt)}</span>
        : <button type="button" className="ghost" onClick={() => revoke(s.id)}>Revoke</button>}
    </li>)}
  </ul>;
}

// Lineups saved to the account: open one on this device, manage its links, or delete it.
export default function Saved() {
  const session = useSession();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [openLinks, setOpenLinks] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const user = session?.user?.username;
  const load = useCallback(() => listWorkspaces().then(d => setList(d.workspaces), e => setError(e.message)), []);
  useEffect(() => { if (user) load(); }, [user, load]);

  const open = async id => {
    try {
      const { workspace } = await getWorkspace(id);
      const drafts = loadDrafts();
      const local = drafts.find(d => d.cloud?.id === id);
      const draft = draftFrom(workspace, local?.id ?? newId());
      saveDrafts([draft, ...drafts.filter(d => d.id !== draft.id)]);
      navigate(`/sandbox?draft=${encodeURIComponent(draft.id)}`);
    } catch (e) { setError(e.message); }
  };
  const remove = async id => {
    try {
      await deleteWorkspace(id);
      saveDrafts(loadDrafts().map(d => (d.cloud?.id === id ? { ...d, cloud: undefined } : d)));
      setConfirm(null);
      await load();
    } catch (e) { setError(e.message); }
  };

  if (!session?.checked) return <section className="roster-page"><p className="loading">Loading</p></section>;
  return <section className="roster-page saved">
    <h1>Saved lineups</h1>
    {!user ? <p className="note">Sign in to see the lineups saved to your account.</p> : <>
      <p className="note">Lineups saved to {user}. Share links show the version they were made from, read only.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {list && !list.length && <p className="note">Nothing saved yet. Build a lineup in the sandbox and save it to your account.</p>}
      {list?.length > 0 && <ul className="saved-list">
        {list.map(w => <li key={w.id}>
          <div className="saved-row">
            <b>{w.title}</b>
            <small>Saved {rosterDay(w.updatedAt)}{w.activeShares ? `, ${w.activeShares} live ${w.activeShares === 1 ? 'link' : 'links'}` : ''}</small>
            <button type="button" className="secondary" onClick={() => open(w.id)}>Open</button>
            <button type="button" className="secondary" aria-expanded={openLinks === w.id} onClick={() => setOpenLinks(openLinks === w.id ? null : w.id)}>Links</button>
            {confirm === w.id
              ? <><button type="button" className="secondary" onClick={() => remove(w.id)}>Delete for good</button><button type="button" className="ghost" onClick={() => setConfirm(null)}>Keep</button></>
              : <button type="button" className="ghost" onClick={() => setConfirm(w.id)}>Delete</button>}
          </div>
          {confirm === w.id && <p className="note">Deleting removes it from your account and stops its links. Copies on your devices stay.</p>}
          {openLinks === w.id && <Shares id={w.id} onChange={load} />}
        </li>)}
      </ul>}
    </>}
  </section>;
}
