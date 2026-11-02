import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { dispatchFeed } from '../apps/call/worker/index.js';
import { d1 } from './helpers/d1Shim.js';

test('ingest is routed and bearer-guarded on the OpVAL Worker', async () => {
  const env = { DB: d1(), FEED_INGEST_TOKEN: 'secret' };
  const post = (headers) => worker.fetch(new Request('https://x.test/internal/ingest', {
    method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, kind: 'heartbeat', runId: 'r1' }),
  }), env);
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'Bearer secret' })).status, 200);
  assert.equal((await worker.fetch(new Request('https://x.test/internal/other', { method: 'POST' }), { ...env, ASSETS: { fetch: async () => new Response('asset') } })).status, 200);
});

test('cron starts the feed workflow on main, and does nothing without a token', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  assert.equal(await dispatchFeed({}, fakeFetch), 'skipped: no token');
  assert.equal(calls.length, 0);
  assert.equal(await dispatchFeed({ GITHUB_DISPATCH_TOKEN: 't' }, fakeFetch), 204);
  assert.match(calls[0].url, /\/actions\/workflows\/feed\.yml\/dispatches$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
});
