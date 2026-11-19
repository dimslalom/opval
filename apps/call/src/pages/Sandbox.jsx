import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import PersonPhoto from '../components/PersonPhoto';
import { teamPath, title } from '../lib/roster';
import { STARTERS, blankDraft, checkLineup, diffFromBase } from '../lib/sandbox';
import { loadDrafts, newId, saveDrafts } from '../lib/drafts';
import { useSession } from '../lib/sessionContext';
import { createShare, draftFrom, isDirty, saveDraft } from '../lib/workspaces';

// A team's lineup as the team page shows it today: Riot's listing with manual entries applied.
function lineupFromTeam(data) {
  const leaving = new Set(data.announced.filter(a => a.move === 'leave').map(a => `${a.kind}|${a.handle.toLowerCase()}`));
  const now = (m) => ({ teamId: data.team.id, team: data.team.name, status: m.status, contractEnd: m.contractEnd });
  const pick = kind => [
    ...data.memberships.filter(m => m.kind === kind && ['present', 'possible'].includes(m.presence) && !leaving.has(`${kind}|${m.handle.toLowerCase()}`))
      .map(m => ({ handle: m.handle, personId: m.personId, now: now(m) })),
    // Manual entries keep their label: announced or reported for this team, not yet in Riot's data.
    ...data.announced.filter(a => a.move === 'join' && a.kind === kind).map(a => ({ handle: a.handle, personId: null, now: null, manual: `${title(a.basis)} for ${data.team.name}` })),
  ];
  return { players: pick('player'), staff: [...pick('coach'), ...pick('staff')] };
}

function Search({ onPick, label }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState({ q: '', people: [] });
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => fetch(`/api/roster/v2/people?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then(r => r.json()).then(d => setFound({ q: query, people: d.people }), () => {}), 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);
  const people = found.q === q.trim() ? found.people : [];
  return <div className="sandbox-search">
    <input className="roster-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a player or coach" aria-label={label} />
    {people.length > 0 && <ul className="sandbox-results">
      {people.map(p => <li key={p.id}><button type="button" onClick={() => { onPick({ handle: p.handle, personId: p.id, now: p.now }); setQ(''); }}>
        <PersonPhoto handle={p.handle} team={p.now?.team} size="chip" /><b>{p.handle}</b><small>{p.now ? p.now.team : 'Not on a tracked team'}</small>
      </button></li>)}
    </ul>}
  </div>;
}

// Saving to the account and making a read-only link. Signed out, drafts stay on this device.
// A save made from an older copy than the account holds is refused; the person then picks which
// copy to keep instead of one silently replacing the other.
function CloudBar({ draft, onSaved }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { error } | { conflict: workspace } | { link }
  const [copied, setCopied] = useState(false);
  if (!session?.user) return <p className="note sandbox-cloud">Sign in to keep lineups on your account and share them as a link.</p>;

  const run = fn => async () => {
    setBusy(true); setMsg(null); setCopied(false);
    try { await fn(); } catch (e) {
      if (e.status === 409 && e.data?.current) setMsg({ conflict: e.data.current });
      else setMsg({ error: e.message });
    }
    setBusy(false);
  };
  const save = run(async () => onSaved(await saveDraft(draft)));
  const share = run(async () => {
    const saved = isDirty(draft) ? await saveDraft(draft) : draft;
    if (saved !== draft) onSaved(saved);
    const { share: made } = await createShare(saved.cloud.id);
    setMsg({ link: `${window.location.origin}${made.path}` });
  });
  const keepTheirs = () => { onSaved(draftFrom(msg.conflict, draft.id), true); setMsg(null); };
  const keepMineAsCopy = run(async () => onSaved(await saveDraft({ ...draft, cloud: undefined, name: `${draft.name} (copy)` }), true));
  const copy = () => navigator.clipboard?.writeText(msg.link).then(() => setCopied(true), () => {});

  return <div className="sandbox-cloud">
    <div className="sandbox-actions">
      <button type="button" className="secondary" onClick={save} disabled={busy || !isDirty(draft)}>{!draft.cloud ? 'Save to account' : isDirty(draft) ? 'Save changes' : 'Saved'}</button>
      <button type="button" className="secondary" onClick={share} disabled={busy}>Create share link</button>
      <Link className="ghost" to="/saved">Saved lineups</Link>
    </div>
    {msg?.error && <p className="error" role="alert">{msg.error}</p>}
    {msg?.conflict && <div className="sandbox-conflict" role="alert">
      <p>This lineup was saved from another device after you opened it. Which copy do you want?</p>
      <div className="sandbox-actions">
        <button type="button" className="secondary" onClick={keepTheirs}>Load the saved copy</button>
        <button type="button" className="secondary" onClick={keepMineAsCopy} disabled={busy}>Keep mine as a new lineup</button>
      </div>
    </div>}
    {msg?.link && <div className="sandbox-link">
      <input readOnly value={msg.link} aria-label="Share link" onFocus={e => e.target.select()} />
      <button type="button" className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <p className="note">Anyone with this link sees this version, read only. Later edits stay private. Revoke it from Saved lineups.</p>
    </div>}
  </div>;
}

// Hypothetical lineups: start from a team's current roster or from nothing, swap people in and out,
// and see which facts the change runs into. Nothing here changes real roster data.
export default function Sandbox() {
  const [params, setParams] = useSearchParams();
  const [drafts, setDrafts] = useState(loadDrafts);
  const [history, setHistory] = useState({ past: [], future: [] });
  const [target, setTarget] = useState({ zone: 'starters', index: null });
  const [error, setError] = useState('');
  const draft = drafts.find(d => d.id === params.get('draft')) ?? null;

  const store = list => { setDrafts(list); saveDrafts(list); };
  const open = id => { setParams({ draft: id }, { replace: false }); setHistory({ past: [], future: [] }); };
  const replace = next => store(drafts.map(d => (d.id === next.id ? { ...next, updatedAt: Date.now() } : d)));
  const change = fn => {
    const next = fn(draft);
    setHistory(h => ({ past: [...h.past, draft].slice(-50), future: [] }));
    replace(next);
  };

  // ?from=<teamId>: a new draft copying that team's lineup today.
  const from = params.get('from');
  useEffect(() => {
    if (!from) return undefined;
    const controller = new AbortController();
    fetch(`/api/roster/v2/teams/${encodeURIComponent(from)}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('That team is not in the roster database.'); return r.json(); })
      .then(data => {
        const { players, staff } = lineupFromTeam(data);
        const d = { ...blankDraft(newId(), `${data.team.name} what-if`), baseTeamId: data.team.id, baseTeam: data.team.name,
          base: [...players, ...staff], starters: [...players.slice(0, STARTERS), ...Array(STARTERS).fill(null)].slice(0, STARTERS),
          bench: players.slice(STARTERS), staff };
        const list = [d, ...loadDrafts()];
        setDrafts(list); saveDrafts(list);
        setParams({ draft: d.id }, { replace: true });
      }, e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [from, setParams]);

  const check = draft ? checkLineup(draft) : null;
  const diff = draft?.baseTeamId ? diffFromBase(draft, draft.base) : null;

  const place = slot => change(d => {
    if (target.zone === 'starters') {
      const i = target.index ?? d.starters.findIndex(s => !s);
      if (i === -1) return { ...d, bench: [...d.bench, slot] };
      const starters = [...d.starters]; starters[i] = slot;
      return { ...d, starters };
    }
    return { ...d, [target.zone]: [...d[target.zone], slot] };
  });
  const removeAt = (zone, i) => change(d => (zone === 'starters'
    ? { ...d, starters: d.starters.map((s, j) => (j === i ? null : s)) }
    : { ...d, [zone]: d[zone].filter((_, j) => j !== i) }));
  const undo = () => { const prev = history.past.at(-1); if (!prev) return; setHistory(h => ({ past: h.past.slice(0, -1), future: [draft, ...h.future] })); replace(prev); };
  const redo = () => { const next = history.future[0]; if (!next) return; setHistory(h => ({ past: [...h.past, draft], future: h.future.slice(1) })); replace(next); };
  // Saves land after an await, so they write into what is stored now, not this render's list.
  // An edit made while the save was in flight is kept (and shows as unsaved); `whole` replaces it.
  const saved = (next, whole = false) => {
    const list = loadDrafts().map(d => (d.id !== next.id ? d : !whole && d.updatedAt > next.cloud.savedAt ? { ...d, cloud: next.cloud } : next));
    setDrafts(list); saveDrafts(list);
  };
  const duplicate = () => { const copy = { ...draft, id: newId(), name: `${draft.name} (copy)`, cloud: undefined }; store([copy, ...drafts]); open(copy.id); };
  const remove = () => { store(drafts.filter(d => d.id !== draft.id)); setParams({}); };
  const blank = () => { const d = blankDraft(newId()); store([d, ...drafts]); open(d.id); };

  const tile = (slot, zone, i) => <li key={`${zone}-${i}`} data-target={target.zone === zone && target.index === i}>
    {slot ? <div className="lineup-tile sandbox-tile">
      <PersonPhoto handle={slot.handle} team={slot.now?.team} />
      <b className="lineup-name">{slot.handle}</b>
      <small>{slot.manual ?? (slot.now ? slot.now.team : 'Not on a tracked team')}</small>
      <button type="button" className="ghost" onClick={() => removeAt(zone, i)} aria-label={`Remove ${slot.handle}`}>Remove</button>
    </div> : <button type="button" className="lineup-tile sandbox-empty" onClick={() => setTarget({ zone, index: i })}>
      <span>Empty seat</span><small>{target.zone === zone && target.index === i ? 'Search below to fill it' : 'Pick to fill'}</small>
    </button>}
  </li>;

  return <section className="roster-page sandbox">
    <h1>Sandbox</h1>
    <p className="note">Hypothetical lineups. Nothing you build here is a real roster or a prediction.</p>
    {error && <p className="error" role="alert">{error}</p>}

    <div className="sandbox-drafts">
      {drafts.map(d => <button key={d.id} type="button" className={d.id === draft?.id ? 'primary' : 'secondary'} onClick={() => open(d.id)}>{d.name}</button>)}
      <button type="button" className="ghost" onClick={blank}>New blank lineup</button>
    </div>
    {!draft && !from && <p className="note">Start from a team's page with "Open in sandbox", or start a blank lineup. Drafts stay on this device until you save them to your account.</p>}

    {draft && <>
      <div className="sandbox-head">
        <input className="sandbox-name" value={draft.name} aria-label="Lineup name" onChange={e => replace({ ...draft, name: e.target.value.slice(0, 60) })} />
        {draft.baseTeamId && <p className="team-meta"><span>Started from</span><Link to={teamPath({ id: draft.baseTeamId, name: draft.baseTeam })}><Crest name={draft.baseTeam} size={18} /> {draft.baseTeam}</Link></p>}
        <div className="sandbox-actions">
          <button type="button" className="secondary" onClick={undo} disabled={!history.past.length}>Undo</button>
          <button type="button" className="secondary" onClick={redo} disabled={!history.future.length}>Redo</button>
          <button type="button" className="secondary" onClick={duplicate}>Duplicate</button>
          <button type="button" className="ghost" onClick={remove}>{draft.cloud ? 'Remove from this device' : 'Delete'}</button>
        </div>
        <CloudBar key={draft.id} draft={draft} onSaved={saved} />
      </div>

      <section className="roster-block">
        <h2 className="sum"><b>{draft.starters.filter(Boolean).length}</b><span>of {STARTERS} starters</span></h2>
        <ul className="lineup seats" style={{ '--n': STARTERS }}>{draft.starters.map((s, i) => tile(s, 'starters', i))}</ul>
      </section>
      {['bench', 'staff'].map(zone => <section key={zone} className="roster-block">
        <h2 className="sum"><b>{draft[zone].length}</b><span>{title(zone)}</span></h2>
        {draft[zone].length > 0 && <ul className="lineup">{draft[zone].map((s, i) => tile(s, zone, i))}</ul>}
      </section>)}

      <section className="roster-block">
        <div className="tier-switch" role="group" aria-label="Add to" style={{ '--n': 3 }}>
          {[['starters', 'Starter seat'], ['bench', 'Bench'], ['staff', 'Staff']].map(([zone, label]) =>
            <button key={zone} type="button" className={target.zone === zone ? 'primary' : undefined} aria-pressed={target.zone === zone}
              onClick={() => setTarget({ zone, index: null })}>{label}</button>)}
        </div>
        <Search label="Add a person" onPick={place} />
      </section>

      <section className="roster-block sandbox-checks" aria-live="polite">
        <h2 className="sum"><span>What this lineup runs into</span></h2>
        <ul>
          {check.errors.map(e => <li key={e} data-level="error">{e}</li>)}
          {check.warnings.map(w => <li key={w.text} data-level="warning">{w.text}</li>)}
          {!check.errors.length && !check.warnings.length && <li data-level="ok">No conflicts with Riot's current data.</li>}
          {check.notChecked.map(n => <li key={n} data-level="unchecked">Not checked: {n}</li>)}
        </ul>
      </section>

      {diff && <section className="roster-block">
        <h2 className="sum"><span>Compared with {draft.baseTeam} today</span></h2>
        {!diff.added.length && !diff.removed.length ? <p className="note">Same people as the real lineup.</p> : <ul className="change-list">
          {diff.added.map(s => <li key={`in-${s.handle}`}><span className="change-verb" data-verb="Joined">In</span><span className="change-who"><PersonPhoto handle={s.handle} team={s.now?.team} size="chip" />{s.handle}</span><span className="change-role" /><span className="change-when">{s.now ? `From ${s.now.team}` : ''}</span></li>)}
          {diff.removed.map(s => <li key={`out-${s.handle}`}><span className="change-verb" data-verb="Left">Out</span><span className="change-who"><PersonPhoto handle={s.handle} team={draft.baseTeam} size="chip" />{s.handle}</span><span className="change-role" /><span className="change-when" /></li>)}
        </ul>}
      </section>}
    </>}
  </section>;
}
