/**
 * Server-side API helper. Calls go to the agent via the Next rewrite at
 * /api/agent/* (forwarded to AGENT_API_URL).
 *
 * On the server we hit the agent directly; on the client we go through the
 * rewrite (which adds CORS / auth in production).
 */
const SERVER_URL = process.env.AGENT_API_URL ?? 'http://localhost:3200';

function isServer(): boolean {
  return typeof window === 'undefined';
}

function url(path: string): string {
  return isServer() ? `${SERVER_URL}/api${path}` : `/api/agent${path}`;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(url(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
