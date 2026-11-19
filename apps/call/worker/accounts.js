// Accounts for OpVAL: /api/auth/{signup,login,logout,me,recovery,reset}, /api/save, /api/leaderboard and /api/bingo{,/score,/leaderboard}.
// Sessions are an HttpOnly cookie holding a random token; the DB keeps only its hash.
// CSRF: SameSite=Lax plus a JSON-only body (a cross-site form cannot send one).
import { createCollection } from '../../../src/engine/collect/game.js';
import { handleBingo, MAX_BINGO_BYTES } from './bingo.js';
import { handleWeeklyBingo } from './weeklyBingo.js';
import { ensureWallet } from './wallet.js';
import { gameAction } from './gameActions.js';
import { calibrationStatus } from './calibration.js';
import { handleTransferBets } from './transferBets.js';
import { publicProfile } from './profile.js';
import { handleWorkspaces, readShare, LIMITS as WORKSPACE_LIMITS } from './rosterWorkspaces.js';

const COOKIE = 'opval_session';
const SESSION_SECS = 60 * 60 * 24 * 30;
const MAX_SAVE_BYTES = 256 * 1024;
const USERNAME = /^[a-z0-9_]{3,20}$/;
const PBKDF2_ITERATIONS = 100_000; // Workers rejects more than this

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const now = () => Math.floor(Date.now() / 1000);
const reply = (body, status = 200, headers) => Response.json(body, { status, headers });

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${hex(salt)}:${hex(await derive(password, salt))}`;
}

async function checkPassword(password, stored) {
  const [salt, want] = stored.split(':');
  const got = await derive(password, unhex(salt));
  const exp = unhex(want);
  let diff = got.length ^ exp.length;
  for (let i = 0; i < got.length; i += 1) diff |= got[i] ^ exp[i];
  return diff === 0;
}

// Burned on unknown usernames so a miss costs the same as a wrong password.
const DUMMY = `${'00'.repeat(16)}:${'00'.repeat(32)}`;

const tokenHash = async token => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));

// Recovery code: 16 characters from a 32-letter alphabet (80 bits), shown once as XXXX-XXXX-XXXX-XXXX.
// Only its hash is stored. Using it resets the password and issues a fresh code.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const raw = [...crypto.getRandomValues(new Uint8Array(16))].map(b => CODE_CHARS[b & 31]).join('');
  return raw.match(/.{4}/g).join('-');
}
const normalizeCode = code => (typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

// Secure only over https: browsers refuse Secure cookies on plain-http localhost, which breaks `wrangler dev`.
function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

// Fixed-window counter in D1. Returns true once `key` has been hit more than `max` times in the window.
// ponytail: counts attempts, so someone can lock a username out for the window; per-IP limits
// stay the main guard. Move to Cloudflare's rate-limit binding if D1 write volume matters.
async function limited(env, key, max, windowSecs) {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN reset_at <= ? THEN 1 ELSE n + 1 END,
       reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
     RETURNING n`,
  ).bind(key, t + windowSecs, t, t, t + windowSecs).first();
  return row.n > max;
}
const ip = request => request.headers.get('CF-Connecting-IP') ?? 'local';
const tooMany = () => reply({ error: 'Too many attempts. Wait a few minutes, then try again.' }, 429);

async function startSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await tokenHash(token), userId, now() + SESSION_SECS).run();
  return token;
}

function cookieToken(request) {
  const m = (request.headers.get('Cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m?.[1] ?? null;
}

async function currentUser(request, env) {
  const token = cookieToken(request);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(await tokenHash(token), now()).first();
}

async function readJson(request, maxBytes = 4096) {
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function credentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  return { username, password };
}

async function signup(request, env) {
  if (await limited(env, `signup:${ip(request)}`, 5, 3600)) return tooMany();
  const { username, password } = credentials(await readJson(request));
  if (!USERNAME.test(username)) return reply({ error: 'Use 3 to 20 letters, numbers or underscores for your username.' }, 400);
  if (password.length < 8 || password.length > 128) return reply({ error: 'Use 8 to 128 characters for your password.' }, 400);
  const recoveryCode = newRecoveryCode();
  let id;
  try {
    const row = await env.DB.prepare('INSERT INTO users (username, pw_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(username, await hashPassword(password), await tokenHash(normalizeCode(recoveryCode)), now()).first();
    id = row.id;
  } catch {
    return reply({ error: 'That username is taken. Try another one.' }, 409);
  }
  const token = await startSession(env, id);
  return reply({ user: { username }, recoveryCode }, 201, { 'Set-Cookie': sessionCookie(request, token, SESSION_SECS) });
}

async function login(request, env) {
  const { username, password } = credentials(await readJson(request));
  if (await limited(env, `login:ip:${ip(request)}`, 20, 900) || await limited(env, `login:user:${username}`, 8, 900)) return tooMany();
  const row = USERNAME.test(username) ? await env.DB.prepare('SELECT id, pw_hash FROM users WHERE username = ?').bind(username).first() : null;
  const ok = await checkPassword(password.slice(0, 128), row?.pw_hash ?? DUMMY);
  if (!row || !ok) return reply({ error: "That username and password don't match. Check them and try again." }, 401);
  const token = await startSession(env, row.id);
  return reply({ user: { username } }, 200, { 'Set-Cookie': sessionCookie(request, token, SESSION_SECS) });
}

async function logout(request, env) {
  const token = cookieToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  return reply({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
}

// Signed in and knows the password: replace the recovery code (for accounts without one, or a lost one).
async function newCode(request, user, env) {
  const { password } = credentials(await readJson(request));
  if (await limited(env, `code:${user.id}`, 8, 900)) return tooMany();
  const row = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!await checkPassword(password.slice(0, 128), row.pw_hash)) return reply({ error: "That password doesn't match this account. Try again." }, 401);
  const recoveryCode = newRecoveryCode();
  await env.DB.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').bind(await tokenHash(normalizeCode(recoveryCode)), user.id).run();
  return reply({ recoveryCode });
}

async function reset(request, env) {
  const body = await readJson(request);
  const { username, password } = credentials(body);
  if (await limited(env, `reset:ip:${ip(request)}`, 10, 3600) || await limited(env, `reset:user:${username}`, 5, 3600)) return tooMany();
  if (password.length < 8 || password.length > 128) return reply({ error: 'Use 8 to 128 characters for your password.' }, 400);
  const row = USERNAME.test(username) ? await env.DB.prepare('SELECT id, recovery_hash FROM users WHERE username = ?').bind(username).first() : null;
  const given = await tokenHash(normalizeCode(body?.code));
  // Compare against a dummy when the user or code is missing so every failure costs the same.
  const want = row?.recovery_hash ?? '0'.repeat(64);
  let diff = given.length ^ want.length;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  if (!row?.recovery_hash || diff !== 0) return reply({ error: "That username and recovery code don't match. Check them and try again." }, 401);
  // New password and a fresh code (the old one is spent), every old session signed out.
  const recoveryCode = newRecoveryCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, recovery_hash = ? WHERE id = ?').bind(await hashPassword(password), await tokenHash(normalizeCode(recoveryCode)), row.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
  ]);
  const session = await startSession(env, row.id);
  return reply({ user: { username }, recoveryCode }, 200, { 'Set-Cookie': sessionCookie(request, session, SESSION_SECS) });
}

async function getSave(user, env) {
  let row = await env.DB.prepare('SELECT state, version FROM saves WHERE user_id = ?').bind(user.id).first();
  if (!row) {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const initial = createCollection({ seed, now: now() });
    await env.DB.prepare('INSERT INTO saves (user_id, state, updated_at, version) VALUES (?, ?, ?, 1) ON CONFLICT(user_id) DO NOTHING')
      .bind(user.id, JSON.stringify(initial), now()).run();
    row = await env.DB.prepare('SELECT state, version FROM saves WHERE user_id = ?').bind(user.id).first();
  }
  const state = JSON.parse(row.state);
  state.credits = (await ensureWallet(env.DB, user.id)).balance;
  return reply({ state, version: row.version });
}

// Rank scored results, not credits: credits can be spent and should never lower a rank.
// The column comes only from this allowlist. A zero-score account stays unranked until
// it reveals a result, while the caller still gets its own score in the response.
async function leaderboard(user, env, url) {
  const columns = { overall: 'overall_points', calls: 'call_points', cards: 'card_points', transfers: 'guess_points' };
  const board = url.searchParams.get('board') ?? 'overall';
  const column = columns[board];
  if (!column) return reply({ error: 'Unknown leaderboard.' }, 400);

  // Points come from the save's history plus calls the server settled that the save has not
  // picked up yet (call_settlements, see settle.js). Once revealed, only history counts them.
  const { results } = await env.DB.prepare(`
    WITH points AS (
      SELECT s.user_id,
        CASE WHEN json_valid(h.value) AND json_type(h.value, '$.callPoints') IN ('integer', 'real')
          THEN MAX(0, CAST(json_extract(h.value, '$.callPoints') AS INTEGER)) ELSE 0 END AS call_points,
        CASE WHEN json_valid(h.value) AND json_type(h.value, '$.trackedPoints') IN ('integer', 'real')
          THEN MAX(0, CAST(json_extract(h.value, '$.trackedPoints') AS INTEGER)) ELSE 0 END AS card_points,
        0 AS guess_points
      FROM saves s, json_each(s.state, '$.history') h
      UNION ALL
      SELECT x.user_id, x.call_points, x.tracked_points, 0
      FROM call_settlements x JOIN saves s ON s.user_id = x.user_id
      WHERE json_type(s.state, '$.revealed."' || x.match_id || '"') IS NULL
      UNION ALL
      -- Settled points-only transfer guesses (staked ones paid credits, not points).
      SELECT user_id, 0, 0, points FROM transfer_bets WHERE points IS NOT NULL
    ), scores AS (
      SELECT p.user_id, u.username, SUM(p.call_points) AS call_points, SUM(p.card_points) AS card_points, SUM(p.guess_points) AS guess_points
      FROM points p JOIN users u ON u.id = p.user_id
      GROUP BY p.user_id
    ), totals AS (
      SELECT user_id, username, call_points, card_points, guess_points,
        call_points + card_points + guess_points AS overall_points FROM scores
    ), ranked AS (
      SELECT user_id, username, ${column} AS points,
        RANK() OVER (ORDER BY ${column} DESC) AS rank,
        ROW_NUMBER() OVER (ORDER BY ${column} DESC, username ASC) AS position
      FROM totals WHERE ${column} > 0
    )
    SELECT user_id, username, points, rank, position FROM ranked
    WHERE position <= 50 OR user_id = ?
    ORDER BY position
  `).bind(user.id).all();
  const me = results.find(row => row.user_id === user.id);
  return reply({
    board,
    entries: results.filter(row => row.position <= 50).map(({ username, points, rank }) => ({ username, points, rank })),
    me: { username: user.username, points: me?.points ?? 0, rank: me?.rank ?? null },
  }, 200, { 'Cache-Control': 'private, no-store' });
}

// The client sends the version it last saw (0 = none yet). A write only lands if that is still
// current; otherwise the server copy comes back in a 409 and the client adopts it. Two devices
// never overwrite each other silently.
async function putSave(request, user, env) {
  const body = await readJson(request, MAX_SAVE_BYTES);
  if (!body || !Number.isInteger(body.version) || body.version < 1) return reply({ error: 'bad save' }, 400);
  const current = await getSave(user, env);
  const remote = await current.json();
  if (body.version !== remote.version || JSON.stringify(body.state) !== JSON.stringify(remote.state)) {
    return reply({ ...remote, error: 'Game actions must be saved through the server' }, 409);
  }
  return reply({ ok: true, version: remote.version });
}

export async function handleAccounts(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/auth/signup' && method === 'POST') return signup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (path === '/api/auth/reset' && method === 'POST') return reset(request, env);

  if (path === '/api/auth/recovery' && method === 'POST') {
    const user = await currentUser(request, env);
    return user ? newCode(request, user, env) : reply({ error: 'not signed in' }, 401);
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const user = await currentUser(request, env);
    return reply({ user: user ? { username: user.username } : null });
  }

  if (path.startsWith('/api/shares/') && method === 'GET') return readShare(env, path.slice('/api/shares/'.length));

  if (path === '/api/workspaces' || path.startsWith('/api/workspaces/')) {
    const user = await currentUser(request, env);
    if (!user) return reply({ error: 'Sign in to save lineups.' }, 401, { 'Cache-Control': 'private, no-store' });
    let body = null;
    if (method === 'POST' || method === 'PUT') {
      body = await readJson(request, WORKSPACE_LIMITS.payloadBytes + 1024);
      if (!body && !path.endsWith('/shares')) return reply({ error: 'Send the lineup as JSON under 64 KB.' }, 413);
    }
    return handleWorkspaces(user, env, method, path, body);
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const user = await currentUser(request, env);
    return user ? leaderboard(user, env, url) : reply({ error: 'not signed in' }, 401);
  }

  if (path === '/api/weekly-bingo/calibration' && method === 'GET') {
    const user = await currentUser(request, env);
    return user ? reply(await calibrationStatus(env.DB)) : reply({ error: 'not signed in' }, 401);
  }

  if (/^\/api\/weekly-bingo(\/score|\/leaderboard)?$/.test(path) && (method === 'GET' || (method === 'PUT' && path === '/api/weekly-bingo'))) {
    const user = await currentUser(request, env);
    if (!user) return reply({ error: 'not signed in' }, 401);
    const body = method === 'PUT' ? await readJson(request, MAX_BINGO_BYTES) : null;
    return handleWeeklyBingo(user, env, url, method, body);
  }

  if (/^\/api\/bingo(\/score|\/leaderboard)?$/.test(path) && method === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return reply({ error: 'not signed in' }, 401);
    const body = method === 'PUT' ? await readJson(request, MAX_BINGO_BYTES) : null;
    return handleBingo(user, env, url, method, body);
  }

  const profile = path.match(/^\/api\/profile\/([a-z0-9_]{3,20})$/i);
  if (profile && method === 'GET') return publicProfile(env, profile[1]);

  if (path === '/api/transfer-bets' && (method === 'GET' || method === 'POST')) {
    const user = await currentUser(request, env);
    if (!user) return reply({ error: 'not signed in' }, 401);
    return handleTransferBets(user, env, method, method === 'POST' ? await readJson(request, 4096) : null);
  }

  if (path === '/api/game/action' && method === 'POST') {
    const user = await currentUser(request, env);
    return user ? gameAction(user, env, await readJson(request, 4096)) : reply({ error: 'not signed in' }, 401);
  }

  if (path === '/api/save' && (method === 'GET' || method === 'PUT')) {
    const user = await currentUser(request, env);
    if (!user) return reply({ error: 'not signed in' }, 401);
    return method === 'GET' ? getSave(user, env) : putSave(request, user, env);
  }

  return null;
}
