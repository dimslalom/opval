import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1Shim.js';
import { handleWorkspaces, readShare, LIMITS } from '../apps/call/worker/rosterWorkspaces.js';

function setup() {
  const db = d1(), env = { DB: db };
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0),(2,'bravo','x',0)").run();
  const as = id => (method, path, body) => handleWorkspaces({ id }, env, method, path, body);
  return { db, env, alpha: as(1), bravo: as(2) };
}
const lineup = (handle = 'TenZ') => ({ baseTeam: 'T1', starters: [{ handle, personId: 7, now: { team: 'T1' } }, null, null, null, null],
  bench: [], staff: [{ handle: 'Sacy', manual: 'Reported for T1' }], notes: 'private thoughts' });
const json = res => res.json();

test('workspaces belong to their owner only, and say so with no-store', async () => {
  const { alpha, bravo } = setup();
  const res = await alpha('POST', '/api/workspaces', { kind: 'sandbox', title: '  T1   what-if ', payload: lineup() });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { workspace } = await json(res);
  assert.equal(workspace.title, 'T1 what-if');
  assert.equal(workspace.revision, 1);

  assert.equal((await json(await bravo('GET', '/api/workspaces'))).workspaces.length, 0);
  for (const [m, p, b] of [['GET', ''], ['PUT', '', { revision: 1, payload: lineup('x') }], ['DELETE', ''], ['POST', '/shares']]) {
    assert.equal((await bravo(m, `/api/workspaces/${workspace.id}${p}`, b)).status, 404, `${m} on someone else's`);
  }
  const mine = await json(await alpha('GET', '/api/workspaces'));
  assert.deepEqual(mine.workspaces.map(w => [w.title, w.activeShares]), [['T1 what-if', 0]]);
});

test('an edit from a stale revision is refused with the newer copy', async () => {
  const { alpha } = setup();
  const { workspace } = await json(await alpha('POST', '/api/workspaces', { kind: 'sandbox', payload: lineup() }));
  const path = `/api/workspaces/${workspace.id}`;
  const first = await json(await alpha('PUT', path, { revision: 1, payload: lineup('aspas') }));
  assert.equal(first.workspace.revision, 2);
  const stale = await alpha('PUT', path, { revision: 1, payload: lineup('Demon1') });
  assert.equal(stale.status, 409);
  const { current } = await json(stale);
  assert.equal(current.revision, 2);
  assert.equal(current.payload.starters[0].handle, 'aspas', 'the other device kept its save');
  assert.equal((await alpha('PUT', path, { payload: lineup() })).status, 400, 'revision is required');
});

test('size and count limits', async () => {
  const { alpha, db } = setup();
  const big = { blob: 'x'.repeat(LIMITS.payloadBytes) };
  assert.equal((await alpha('POST', '/api/workspaces', { kind: 'sandbox', payload: big })).status, 413);
  assert.equal((await alpha('POST', '/api/workspaces', { kind: 'other', payload: {} })).status, 400);
  const insert = db.sqlite.prepare("INSERT INTO roster_workspaces(id,user_id,kind,title,payload,created_at,updated_at) VALUES(?,1,'sandbox','t','{}',0,0)");
  for (let i = 0; i < LIMITS.workspaces; i++) insert.run(`w${i}`);
  assert.equal((await alpha('POST', '/api/workspaces', { kind: 'sandbox', payload: {} })).status, 409);
});

test('a share is a frozen, trimmed copy that stops working when revoked or deleted', async () => {
  const { alpha, env } = setup();
  const { workspace } = await json(await alpha('POST', '/api/workspaces', { kind: 'sandbox', title: 'T1 what-if', payload: lineup() }));
  const base = `/api/workspaces/${workspace.id}`;
  const made = await alpha('POST', `${base}/shares`, null);
  assert.equal(made.status, 201);
  const { share } = await json(made);
  const token = share.path.slice(3);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  // Only the hash is stored.
  const stored = env.DB.sqlite.prepare('SELECT token_hash FROM roster_shares').get().token_hash;
  assert.notEqual(stored, token);

  await alpha('PUT', base, { revision: 1, payload: lineup('aspas') });
  const seen = await readShare(env, token);
  assert.equal(seen.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(seen.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const view = await json(seen);
  assert.equal(view.title, 'T1 what-if');
  assert.equal(view.revision, 1);
  assert.equal(view.view.starters[0].handle, 'TenZ', 'later edits do not reach the link');
  assert.equal(view.view.notes, undefined, 'only the lineup is shared');
  assert.deepEqual(view.view.staff[0], { handle: 'Sacy', team: null, manual: 'Reported for T1' });

  const list = await json(await alpha('GET', `${base}/shares`));
  assert.equal(list.shares.length, 1);
  assert.equal(list.shares[0].path, undefined, 'the token is shown once, at creation');

  await alpha('DELETE', `${base}/shares/${share.id}`);
  assert.equal((await readShare(env, token)).status, 404);

  const again = (await json(await alpha('POST', `${base}/shares`))).share.path.slice(3);
  assert.equal((await readShare(env, again)).status, 200);
  await alpha('DELETE', base);
  assert.equal((await readShare(env, again)).status, 404, 'deleting the lineup revokes its links');
  assert.equal((await readShare(env, 'short')).status, 404);
});

test('live links per lineup are capped', async () => {
  const { alpha } = setup();
  const { workspace } = await json(await alpha('POST', '/api/workspaces', { kind: 'sandbox', payload: lineup() }));
  for (let i = 0; i < LIMITS.activeShares; i++) assert.equal((await alpha('POST', `/api/workspaces/${workspace.id}/shares`)).status, 201);
  assert.equal((await alpha('POST', `/api/workspaces/${workspace.id}/shares`)).status, 409);
});
