import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1Shim.js';
import { ingestContracts } from '../worker/feed/roster.js';
import { handleTransferBets, settleTransferBets } from '../apps/call/worker/transferBets.js';
import { publicProfile } from '../apps/call/worker/profile.js';
import { nextLock, payoutOf } from '../apps/call/src/lib/transferBets.js';

const t0 = Date.parse('2026-10-20T00:00:00Z') / 1000;
const lock = nextLock(t0);
const row = (player, team) => ({ player, team, league: 'Pacific', contractEnd: '2027 Season End' });
const rrq = ['monyet', 'crazyguy', 'Jemkin', 'xffero', 'Kushy'].map(p => row(p, 'Rex Regum Qeon'));
const body = res => res.json();

test('payout pays each hit leg its share of stake x (legs + 1)', () => {
  assert.equal(payoutOf(100, 3, 3), 400);
  assert.equal(payoutOf(100, 3, 1), 133);
  assert.equal(payoutOf(100, 1, 0), 0);
});

test('Xavi8k to RRQ replacing monyet and crazyguy: points only, roster lock, partial settle', async () => {
  const db = d1(), env = { DB: db }, user = { id: 1 };
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify({ credits: 300 }));
  await ingestContracts(db, { contracts: [...rrq, row('Xavi8k', 'Team Secret')] }, t0 - 100);

  // Monyet replaced by Xavi8k, Crazyguy leaving for Team Secret: 4 legs.
  const moves = [{ out: 'monyet|pacific', in: 'Xavi8k' }, { out: 'crazyguy|pacific', to: 'Team Secret' }];
  const post = b => handleTransferBets(user, env, 'POST', b, t0);
  assert.equal((await post({ moves: [{ out: 'monyet|pacific', in: 'Jemkin' }] })).status, 400, 'already on the team');
  assert.equal((await post({ moves: [{ out: 'nope|pacific', in: 'Xavi8k' }] })).status, 400, 'not on a team');
  assert.equal((await post({ moves: [{ out: 'monyet|pacific', in: 'Xavi8k', to: 'Team Secret' }] })).status, 400, 'one destination');
  assert.equal((await post({ moves: [{ out: 'monyet|pacific', to: 'Rex Regum Qeon' }] })).status, 400, 'same team');
  const wallet = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id=1').get().n;
  const placed = await body(await post({ moves, stake: 100 })); // a stake sent by an old client is ignored
  assert.equal(placed.bet.stake, null);
  assert.equal(wallet(), 0, 'nothing is staked');
  assert.equal(placed.bet.deadline, lock);
  assert.equal(placed.bet.legs.length, 4);

  // Xavi8k joins RRQ and monyet leaves; crazyguy stays. Each change needs two Riot reads to confirm.
  const after = [...rrq.filter(r => r.player !== 'monyet'), row('Xavi8k', 'Rex Regum Qeon')];
  await ingestContracts(db, { contracts: after }, t0 + 3600);
  await ingestContracts(db, { contracts: after }, t0 + 7200);
  const live = await body(await handleTransferBets(user, env, 'GET', null, t0 + 7300));
  assert.deepEqual(live.bets[0].legs.map(l => `${l.type}:${l.player}:${l.hit}`), ['leave:monyet:true', 'join:Xavi8k:true', 'leave:crazyguy:false', 'join:crazyguy:false']);

  assert.equal(await settleTransferBets(env, lock + 10), 0, 'waits for two Riot reads after the lock');
  await ingestContracts(db, { contracts: after }, lock + 60);
  await ingestContracts(db, { contracts: after }, lock + 120);
  assert.equal(await settleTransferBets(env, lock + 200), 1);
  assert.equal(await settleTransferBets(env, lock + 300), 0, 'settles once');
  const done = await body(await handleTransferBets(user, env, 'GET', null, lock + 400));
  assert.equal(done.bets[0].hits, 2);
  assert.equal(done.bets[0].points, 20); // two right calls, ten points each
  assert.equal(wallet(), 0, 'and nothing is paid');

  const profile = await body(await publicProfile(env, 'alpha', lock + 400));
  assert.equal(profile.guesses[0].points, 20);
  assert.equal('credits' in profile, false, 'profile is public: no wallet');
  assert.equal((await publicProfile(env, 'nobody', lock)).status, 404);
});

test('a guess staked before points-only still settles in credits, as placed', async () => {
  const db = d1(), env = { DB: db };
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify({ credits: 300 }));
  await ingestContracts(db, { contracts: rrq }, t0 - 100);
  const legs = [{ type: 'leave', key: 'monyet|pacific', player: 'monyet', team: 'Rex Regum Qeon' }];
  db.sqlite.prepare('INSERT INTO transfer_bets(id,user_id,team,legs,stake,placed_at,deadline) VALUES(?,1,?,?,100,?,?)')
    .run('old', 'Rex Regum Qeon', JSON.stringify(legs), t0, lock);
  const after = rrq.filter(r => r.player !== 'monyet');
  for (const t of [t0 + 3600, t0 + 7200, lock + 60, lock + 120]) await ingestContracts(db, { contracts: after }, t);
  assert.equal(await settleTransferBets(env, lock + 200), 1);
  const row = db.sqlite.prepare("SELECT payout,points FROM transfer_bets WHERE id='old'").get();
  assert.deepEqual([row.payout, row.points], [payoutOf(100, 1, 1), null]);
  assert.equal(db.sqlite.prepare("SELECT amount FROM wallet_entries WHERE entry_key='transfer-pay:old'").get().amount, 200);
});
