// Private saved work and the read-only links made from it (migration 0020).
//   GET/POST         /api/workspaces                    your workspaces / save a new one
//   GET/PUT/DELETE   /api/workspaces/:id                 read, update (with the revision you edited), delete
//   GET/POST         /api/workspaces/:id/shares          its links / freeze the current revision into a new link
//   DELETE           /api/workspaces/:id/shares/:shareId revoke a link
//   GET              /api/shares/:token                  anyone with the link (no session)
// The owner always comes from the session, never from the request. Nothing here is cacheable.

export const LIMITS = { payloadBytes: 64 * 1024, workspaces: 100, activeShares: 20, sharesPerHour: 30 };
const PRIVATE = { 'Cache-Control': 'private, no-store' };
const reply = (body, status = 200, headers = PRIVATE) => Response.json(body, { status, headers });
const now = () => Math.floor(Date.now() / 1000);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const hashOf = async token => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
const KINDS = new Set(['sandbox']);

const summary = r => ({ id: r.id, kind: r.kind, title: r.title, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.active_shares != null ? { activeShares: r.active_shares } : {}) });
const full = r => ({ ...summary(r), schema: r.schema, payload: JSON.parse(r.payload) });

function validPayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const text = JSON.stringify(payload);
  return new TextEncoder().encode(text).byteLength <= LIMITS.payloadBytes ? text : null;
}
const title = s => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Untitled';

// What a share link shows: the lineup by name and team only. No account details, no notes.
function shareView(kind, payload) {
  const slot = s => (s && typeof s === 'object' ? { handle: String(s.handle ?? '').slice(0, 40), team: s.now?.team ?? null, manual: s.manual ?? null } : null);
  const list = v => (Array.isArray(v) ? v.slice(0, 20).map(slot).filter(Boolean) : []);
  return { baseTeam: payload.baseTeam ?? null, starters: Array.isArray(payload.starters) ? payload.starters.slice(0, 5).map(slot) : [],
    bench: list(payload.bench), staff: list(payload.staff) };
}

async function owned(db, user, id) {
  return db.prepare('SELECT * FROM roster_workspaces WHERE id=? AND user_id=?').bind(id, user.id).first();
}

export async function handleWorkspaces(user, env, method, path, body) {
  const db = env.DB;
  if (path === '/api/workspaces') {
    if (method === 'GET') {
      const rows = (await db.prepare(`SELECT w.*,(SELECT COUNT(*) FROM roster_shares s WHERE s.workspace_id=w.id AND s.revoked_at IS NULL) AS active_shares
        FROM roster_workspaces w WHERE w.user_id=? ORDER BY w.updated_at DESC LIMIT ?`).bind(user.id, LIMITS.workspaces).all()).results;
      return reply({ workspaces: rows.map(summary), limits: LIMITS });
    }
    if (method === 'POST') {
      if (!KINDS.has(body?.kind)) return reply({ error: 'Unknown kind of saved work.' }, 400);
      const text = validPayload(body.kind, body.payload);
      if (!text) return reply({ error: `Saved work must be under ${LIMITS.payloadBytes / 1024} KB.` }, 413);
      const count = (await db.prepare('SELECT COUNT(*) AS n FROM roster_workspaces WHERE user_id=?').bind(user.id).first()).n;
      if (count >= LIMITS.workspaces) return reply({ error: `You can keep ${LIMITS.workspaces} saved lineups. Delete one to save another.` }, 409);
      const id = crypto.randomUUID(), t = now();
      await db.prepare('INSERT INTO roster_workspaces(id,user_id,kind,title,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id, user.id, body.kind, title(body.title), text, t, t).run();
      return reply({ workspace: full(await owned(db, user, id)) }, 201);
    }
    return reply({ error: 'method not allowed' }, 405);
  }

  const m = path.match(/^\/api\/workspaces\/([0-9a-f-]{36})(?:\/shares(?:\/([0-9a-f-]{36}))?)?$/);
  if (!m) return reply({ error: 'not found' }, 404);
  const [, id, shareId] = m;
  const sharesPath = path.includes('/shares');
  const ws = await owned(db, user, id);
  if (!ws) return reply({ error: 'Not found.' }, 404); // someone else's looks the same as none

  if (!sharesPath) {
    if (method === 'GET') return reply({ workspace: full(ws) });
    if (method === 'PUT') {
      const text = validPayload(ws.kind, body?.payload);
      if (!text) return reply({ error: `Saved work must be under ${LIMITS.payloadBytes / 1024} KB.` }, 413);
      if (!Number.isInteger(body?.revision)) return reply({ error: 'Say which revision you edited.' }, 400);
      const res = await db.prepare(`UPDATE roster_workspaces SET title=?,payload=?,revision=revision+1,updated_at=?
        WHERE id=? AND user_id=? AND revision=?`).bind(title(body.title ?? ws.title), text, now(), id, user.id, body.revision).run();
      // Another device saved first: hand back its version instead of overwriting it.
      if (!res.meta.changes) return reply({ error: 'This lineup changed on another device.', current: full(await owned(db, user, id)) }, 409);
      return reply({ workspace: full(await owned(db, user, id)) });
    }
    if (method === 'DELETE') {
      await db.batch([
        db.prepare('UPDATE roster_shares SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL').bind(now(), id),
        db.prepare('DELETE FROM roster_workspaces WHERE id=? AND user_id=?').bind(id, user.id),
      ]);
      return reply({ ok: true });
    }
    return reply({ error: 'method not allowed' }, 405);
  }

  if (!shareId && method === 'GET') {
    const rows = (await db.prepare('SELECT id,revision,created_at,revoked_at FROM roster_shares WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC')
      .bind(id, user.id).all()).results;
    return reply({ shares: rows.map(r => ({ id: r.id, revision: r.revision, createdAt: r.created_at, revokedAt: r.revoked_at })) });
  }
  if (!shareId && method === 'POST') {
    const t = now();
    const active = (await db.prepare('SELECT COUNT(*) AS n FROM roster_shares WHERE workspace_id=? AND revoked_at IS NULL').bind(id).first()).n;
    if (active >= LIMITS.activeShares) return reply({ error: `This lineup has ${LIMITS.activeShares} live links. Revoke one first.` }, 409);
    const recent = (await db.prepare('SELECT COUNT(*) AS n FROM roster_shares WHERE user_id=? AND created_at>?').bind(user.id, t - 3600).first()).n;
    if (recent >= LIMITS.sharesPerHour) return reply({ error: 'Too many links this hour. Try again later.' }, 429);
    // 32 random bytes, base64url: the link is the only key, so it must not be guessable.
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const share = crypto.randomUUID();
    await db.prepare(`INSERT INTO roster_shares(id,workspace_id,user_id,token_hash,kind,title,payload,revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(share, id, user.id, await hashOf(token), ws.kind, ws.title,
      JSON.stringify(shareView(ws.kind, JSON.parse(ws.payload))), ws.revision, t).run();
    return reply({ share: { id: share, revision: ws.revision, createdAt: t, path: `/s/${token}` } }, 201);
  }
  if (shareId && method === 'DELETE') {
    await db.prepare('UPDATE roster_shares SET revoked_at=? WHERE id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL')
      .bind(now(), shareId, id, user.id).run();
    return reply({ ok: true });
  }
  return reply({ error: 'method not allowed' }, 405);
}

// Anyone with the link. Read from the primary on every request (no cache), so a revoke takes effect
// on the next view. Unknown and revoked look the same.
export async function readShare(env, token) {
  const headers = { ...PRIVATE, 'X-Robots-Tag': 'noindex, nofollow' };
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return reply({ error: 'This link was revoked or never existed.' }, 404, headers);
  const row = await env.DB.prepare('SELECT kind,title,payload,revision,created_at FROM roster_shares WHERE token_hash=? AND revoked_at IS NULL')
    .bind(await hashOf(token)).first();
  if (!row) return reply({ error: 'This link was revoked or never existed.' }, 404, headers);
  return reply({ kind: row.kind, title: row.title, revision: row.revision, createdAt: row.created_at, view: JSON.parse(row.payload) }, 200, headers);
}
