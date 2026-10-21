import { storage } from './storage.ts';

export interface RecentDoc {
  id: string;
  name: string;
  editToken?: string;
  viewToken?: string;
  openedAt: number;
}

export interface CreatedDoc {
  id: string;
  name: string;
  editToken: string;
  viewToken: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(body.message ?? `request failed (${res.status})`);
  return body as T;
}

export function createDoc(name?: string): Promise<CreatedDoc> {
  return request('/api/docs', { method: 'POST', body: JSON.stringify(name ? { name } : {}) });
}

export function renameDoc(id: string, token: string, name: string): Promise<{ name: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

export function rotateLinks(
  id: string,
  token: string,
): Promise<{ editToken: string; viewToken: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/rotate-links`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Tokens travel in the URL fragment so they never reach server logs. */
export function docLink(id: string, role: 'edit' | 'view', token: string): string {
  return `${location.origin}/d/${encodeURIComponent(id)}#${role}=${encodeURIComponent(token)}`;
}

export function tokenFromHash(hash: string): { role: 'edit' | 'view'; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const edit = params.get('edit');
  if (edit) return { role: 'edit', token: edit };
  const view = params.get('view');
  if (view) return { role: 'view', token: view };
  return null;
}

const RECENT_KEY = 'tandem.recent';

export function recentDocs(): RecentDoc[] {
  const list = storage.get<RecentDoc[]>(RECENT_KEY, []);
  return Array.isArray(list) ? list.sort((a, b) => b.openedAt - a.openedAt) : [];
}

export function rememberDoc(doc: Omit<RecentDoc, 'openedAt'>): void {
  const others = recentDocs().filter((d) => d.id !== doc.id);
  const prev = recentDocs().find((d) => d.id === doc.id);
  storage.set(RECENT_KEY, [{ ...prev, ...doc, openedAt: Date.now() }, ...others].slice(0, 30));
}

export function forgetDoc(id: string): void {
  storage.set(
    RECENT_KEY,
    recentDocs().filter((d) => d.id !== id),
  );
}

const NAME_KEY = 'tandem.name';

export function displayName(): string {
  return storage.get<string>(NAME_KEY, '');
}

export function setDisplayName(name: string): void {
  storage.set(NAME_KEY, name.trim().slice(0, 40));
}
