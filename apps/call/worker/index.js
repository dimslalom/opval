import { handleFeed } from '../../../worker/feed/routes.js';
import { getRoster } from '../../../worker/feed/roster.js';
import { handleAccounts } from './accounts.js';
import { settleAll } from './settle.js';
import { settleWeeklyBingo } from './weeklyBingo.js';
import { calibratePaid } from './calibration.js';
import { settleTransferBets } from './transferBets.js';

// OpVAL's Worker: the shared feed database (read-only API plus bearer-guarded ingest, which
// needs a FEED_INGEST_TOKEN secret), accounts and cloud saves (accounts.js). Static files
// bypass this Worker entirely (see wrangler.jsonc).

const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the Rive runtime compile its self-hosted wasm.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function secure(response) {
  const out = new Response(response.body, response);
  out.headers.set('Content-Security-Policy', CSP);
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return out;
}

// The feed job (vlr.gg scraper) runs in GitHub Actions, but GitHub's own schedule is best-effort
// and often skips hours. Cloudflare cron fires on time, so this starts that workflow every 15
// minutes. Needs a GITHUB_DISPATCH_TOKEN secret (fine-grained, Actions: write on this repo);
// without it the cron does nothing. The workflow's concurrency group queues overlapping runs.
const FEED_WORKFLOW = 'https://api.github.com/repos/dimslalom/opval/actions/workflows/feed.yml/dispatches';
export async function dispatchFeed(env, fetchImpl = fetch) {
  if (!env.GITHUB_DISPATCH_TOKEN) return 'skipped: no token';
  const res = await fetchImpl(FEED_WORKFLOW, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'opval-feed-cron',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) console.error(`feed dispatch failed: ${res.status} ${await res.text()}`);
  return res.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchFeed(env));
    ctx.waitUntil((async () => { await settleWeeklyBingo(env); await calibratePaid(env); })().catch(e => console.error(`weekly bingo settlement/calibration failed: ${e.stack ?? e}`)));
    ctx.waitUntil(settleTransferBets(env).catch(e => console.error(`transfer bet settlement failed: ${e.stack ?? e}`)));
    ctx.waitUntil(settleAll(env).catch(e => console.error(`settle failed: ${e.stack ?? e}`)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/roster/')) return secure(await getRoster(env.DB, url.pathname, url));
    if (url.pathname.startsWith('/api/feed/') || url.pathname === '/internal/ingest') return secure(await handleFeed(request, env, url));
    if (url.pathname.startsWith('/api/')) {
      const res = await handleAccounts(request, env, url);
      return secure(res ?? Response.json({ error: 'not found' }, { status: 404 }));
    }

    // HTML routes: the app shell for any client-side route.
    const wantsHtml = request.method === 'GET' && (request.headers.get('Accept') ?? '').includes('text/html');
    const asset = await env.ASSETS.fetch(wantsHtml ? new Request(new URL('/', url.origin), request) : request);
    return secure(asset);
  },
};
