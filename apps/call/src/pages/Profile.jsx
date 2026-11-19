import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Fan from '../components/Fan';
import CardThumb from '../components/CardThumb';
import Receipt from '../components/Receipt';
import Sheet from '../components/Sheet';
import { AccountSettings } from '../components/AccountForm';
import { GuessStrip } from '../components/TransferBets';
import { useGame } from '../lib/gameContext';
import { logoFor } from '../lib/orgs';
import { playHome } from '../lib/playNavigation';

const since = s => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

// Anyone's profile, shareable by link: their Tracked hand, every card they own, their roster
// guesses and their match calls once those matches started.
export default function Profile() {
  const { username } = useParams();
  const { players, account } = useGame();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/profile/${encodeURIComponent(username)}`).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? 'Profile is unavailable');
      setData(body);
    }).catch(e => setError(e.message));
  }, [username]);

  const share = async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: `${username} on OpVAL`, url });
      else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    } catch { /* share sheet dismissed */ }
  };

  if (error) return <section><h1>{username}</h1><p className="note" role="alert">{error}</p></section>;
  if (!data) return <section><h1>{username}</h1><p className="note">Loading profile</p></section>;

  const cardOf = pid => players[pid]?.card;
  const hand = data.tracked.filter(cardOf).sort((a, b) => cardOf(b).rating - cardOf(a).rating);
  const owned = [...new Set(data.collection)].filter(cardOf).sort((a, b) => cardOf(b).rating - cardOf(a).rating);
  const mine = account.user?.username === data.username;

  return <section className="profile">
    <header className="profile-head">
      <div>
        <h1>{data.username}</h1>
        <small>Since {since(data.joinedAt)}</small>
      </div>
      <button type="button" className="secondary" onClick={share}>{copied ? 'Link copied' : 'Share'}</button>
    </header>

    <div className="matches-overview profile-stats">
      <span><strong>{data.score}</strong> points</span>
      <span><strong>{data.record.right}/{data.record.made}</strong> calls right</span>
      <span><strong>{data.guesses.reduce((n, g) => n + g.legs.filter(l => l.hit).length, 0)}</strong> moves called</span>
    </div>

    {hand.length > 0 && <Fan pids={hand} cardOf={cardOf} scale={0.26} arc={1.6} />}

    {data.guesses.length > 0 && <section className="roster-block">
      <h2 className="sum"><b>{data.guesses.length}</b><span>roster {data.guesses.length === 1 ? 'guess' : 'guesses'}</span></h2>
      <GuessStrip guesses={data.guesses} onOpen={setReceipt} />
    </section>}

    {data.calls.length > 0 && <section className="roster-block">
      <h2 className="sum"><b>{data.calls.length}</b><span>match {data.calls.length === 1 ? 'call' : 'calls'}</span></h2>
      <ul className="profile-calls">
        {data.calls.map(c => <li key={c.matchId} data-right={c.right}>
          {c.teams.map(t => <span key={t.tag} className="profile-call-team" data-picked={c.call?.winner === t.tag}>
            {logoFor(t.tag) ? <img src={logoFor(t.tag)} alt="" /> : <span className="crest crest-mono">{t.tag?.slice(0, 3)}</span>}
            <b>{t.tag}</b>
          </span>)}
          <b className="profile-call-pts">{c.points != null ? `+${c.points}` : c.status === 'final' ? '' : 'Live'}</b>
        </li>)}
      </ul>
    </section>}

    {owned.length > 0 && <section className="roster-block">
      <h2 className="sum"><b>{owned.length}</b><span>{owned.length === 1 ? 'card' : 'cards'} owned</span></h2>
      <div className="profile-cards">{owned.map(pid => <CardThumb key={pid} card={cardOf(pid)} scale={0.2} />)}</div>
    </section>}

    <Sheet open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Receipt">
      {receipt && <Receipt guess={receipt} username={data.username} />}
    </Sheet>
    {mine && data.guesses.length === 0 && data.calls.length === 0 && <p className="note">Your guesses and calls land here.</p>}

    {/* Your own profile is also your account: the controls only you see. */}
    {mine && <section className="roster-block profile-account">
      <h2 className="section">Account</h2>
      <AccountSettings onDone={() => {}} onSignOut={() => navigate(playHome)} />
    </section>}
  </section>;
}
