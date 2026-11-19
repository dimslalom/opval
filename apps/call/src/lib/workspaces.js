import { api } from './account';

// Sandbox drafts saved to the account (worker/rosterWorkspaces.js). A local draft that has been
// saved carries `cloud: { id, revision, savedAt }`; savedAt is the draft's updatedAt when it was
// last sent, so "unsaved changes" is updatedAt > savedAt.
export const payloadOf = d => ({ name: d.name, baseTeamId: d.baseTeamId, baseTeam: d.baseTeam, base: d.base, starters: d.starters, bench: d.bench, staff: d.staff });
export const isDirty = d => !d.cloud || d.updatedAt > d.cloud.savedAt;

export const listWorkspaces = () => api('GET', '/api/workspaces');
export const getWorkspace = id => api('GET', `/api/workspaces/${id}`);
export const deleteWorkspace = id => api('DELETE', `/api/workspaces/${id}`);
export const listShares = id => api('GET', `/api/workspaces/${id}/shares`);
export const createShare = id => api('POST', `/api/workspaces/${id}/shares`, {});
export const revokeShare = (id, shareId) => api('DELETE', `/api/workspaces/${id}/shares/${shareId}`);

// Saves a draft: a new workspace the first time, an update after. On a conflict the error carries
// the account's newer copy as e.data.current.
export async function saveDraft(d) {
  const body = { title: d.name, payload: payloadOf(d) };
  const { workspace } = d.cloud
    ? await api('PUT', `/api/workspaces/${d.cloud.id}`, { ...body, revision: d.cloud.revision })
    : await api('POST', '/api/workspaces', { kind: 'sandbox', ...body });
  return { ...d, cloud: { id: workspace.id, revision: workspace.revision, savedAt: d.updatedAt } };
}

// A workspace from the account as a local draft (keeping the local id if this device has it).
export function draftFrom(workspace, localId) {
  const p = workspace.payload;
  const updatedAt = workspace.updatedAt * 1000;
  return { id: localId, name: p.name ?? workspace.title, baseTeamId: p.baseTeamId ?? null, baseTeam: p.baseTeam ?? null, base: p.base ?? [],
    starters: p.starters ?? [null, null, null, null, null], bench: p.bench ?? [], staff: p.staff ?? [], updatedAt,
    cloud: { id: workspace.id, revision: workspace.revision, savedAt: updatedAt } };
}
