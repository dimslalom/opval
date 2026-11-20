import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PersonPhoto from '../components/PersonPhoto';
import { rosterDay } from '../lib/time';

const Tile = ({ slot }) => (slot
  ? <li><div className="lineup-tile sandbox-tile">
    <PersonPhoto handle={slot.handle} team={slot.team} />
    <b className="lineup-name">{slot.handle}</b>
    <small>{slot.manual ?? slot.team ?? 'Not on a tracked team'}</small>
  </div></li>
  : <li><div className="lineup-tile sandbox-empty"><span>Empty seat</span></div></li>);

// A read-only lineup someone shared. It is a copy of one version: the owner's later edits never
// reach it, and it stops working when they revoke it.
export default function SharedLineup() {
  const { token } = useParams();
  const [state, setState] = useState({ token: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/shares/${encodeURIComponent(token)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => setState({ token, ok: r.ok, data: await r.json() }), e => { if (e.name !== 'AbortError') setState({ token, ok: false, data: { error: "Can't reach the OpVAL server." } }); });
    return () => controller.abort();
  }, [token]);

  if (state.token !== token) return <section className="roster-page"><p className="loading">Loading</p></section>;
  if (!state.ok) return <section className="roster-page">
    <h1>Shared lineup</h1>
    <p className="note">{state.data.error}</p>
    <Link className="secondary" to="/sandbox">Build a lineup in the sandbox</Link>
  </section>;
  const { title, createdAt, view } = state.data;
  return <section className="roster-page sandbox">
    <h1>{title}</h1>
    <p className="note">A hypothetical lineup shared on {rosterDay(createdAt)}{view.baseTeam ? `, starting from ${view.baseTeam}` : ''}. Read only, and not a real roster or a prediction.</p>
    <section className="roster-block">
      <h2 className="sum"><b>{view.starters.filter(Boolean).length}</b><span>of 5 starters</span></h2>
      <ul className="lineup seats" style={{ '--n': 5 }}>{view.starters.map((s, i) => <Tile key={i} slot={s} />)}</ul>
    </section>
    {[['bench', 'Bench'], ['staff', 'Staff']].filter(([k]) => view[k].length).map(([k, label]) => <section key={k} className="roster-block">
      <h2 className="sum"><b>{view[k].length}</b><span>{label}</span></h2>
      <ul className="lineup">{view[k].map((s, i) => <Tile key={i} slot={s} />)}</ul>
    </section>)}
    <p><Link className="secondary" to="/sandbox">Build your own in the sandbox</Link></p>
  </section>;
}
