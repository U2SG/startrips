import { activateAccountScope, accountGeneration } from './accountScope';
export { sessionGuard } from './accountScope';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import type { Settings } from './settings';
import { writeToken } from './tokenStore';
import { fetchWithLifetime } from './fetchLifetime';

export type Entry = { name: string; dir: boolean; size: number; mtime: number };
let cfg: Pick<Settings, 'serverUrl' | 'token'> = { serverUrl: '', token: '' };
let sessionUser = '';
const revisions = new Map<string, string | null>();
const unauthorized = new Set<() => void | Promise<void>>();
export function configureApi(settings: Pick<Settings, 'serverUrl' | 'token'>) {
  if (cfg.serverUrl !== settings.serverUrl || cfg.token !== settings.token) revisions.clear();
  cfg = settings;
}
export function serverCfg() { return cfg; }
export function bindSessionUser(userId: string) { sessionUser = userId; }
export function onUnauthorized(listener: () => void | Promise<void>) { unauthorized.add(listener); return () => { unauthorized.delete(listener); }; }
export function clearCredentials() { sessionUser = ''; activateAccountScope(''); for (const controller of pendingRequests) controller.abort(); cfg = { ...cfg, token: '' }; revisions.clear(); }

const pendingRequests = new Set<AbortController>();
// Callers must abort their owner signal after consuming the response body.
export async function authFetch(endpoint: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const current = cfg;
  const generation = accountGeneration();
  const headers = new Headers(init.headers);
  if (Platform.OS !== 'web' && current.token) headers.set('Authorization', `Bearer ${current.token}`);
  if (sessionUser && endpoint.startsWith('/api/soc/')) headers.set('X-Soc-User', sessionUser);
  const response = await fetchWithLifetime((signal) => expoFetch(`${current.serverUrl}${endpoint}`, { ...init, headers, credentials: 'include', signal }), init.signal, pendingRequests);
  if (generation !== accountGeneration()) { await response.body?.cancel(); throw new Error('账号已切换'); }
  const refreshed = response.headers.get('set-auth-token');
  if (Platform.OS !== 'web' && refreshed && current === cfg) { cfg = { ...cfg, token: refreshed }; await writeToken(cfg.serverUrl, refreshed); }
  // An anonymous browser session probe is expected to return 401. Expiring it
  // would abort its own response body and report a false connection failure.
  if (response.status === 401 && !endpoint.startsWith('/api/auth/') && (Platform.OS !== 'web' || sessionUser)) {
    await Promise.all([...unauthorized].map((listener) => listener()));
  }
  return response;
}

export async function authJson<T>(endpoint: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; value: T }> {
  const owner = new AbortController();
  const deadline = setTimeout(() => owner.abort(), 180000);
  try {
    const response = await authFetch(endpoint, { ...init, signal: owner.signal });
    return { ok: response.ok, status: response.status, value: await response.json() as T };
  } finally { clearTimeout(deadline); owner.abort(); }
}

async function request<T>(endpoint: string, init: RequestInit = {}, timeoutMs = 180000,
  consume: (response: Response) => Promise<T> = (response) => response.json(),
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const signal = controller.signal;
  try {
    const response = await authFetch(`/api/soc${endpoint}`, { ...init, signal });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { const error = await response.json(); message = error.message || error.error || message; } catch {}
      const failure = Object.assign(new Error(message), { status: response.status });
      throw failure;
    }
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请检查网络后重试');
    throw error;
  } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); controller.abort(); }
}

const fileUrl = (endpoint: string, path: string) => `${endpoint}?path=${encodeURIComponent(path)}`;
export async function ping(): Promise<{ ok: boolean; root: string }> { return request('/ping', {}, 15000); }
export async function list(path: string): Promise<Entry[]> { return (await request<{ entries: Entry[] }>(fileUrl('/list', path), {}, 15000)).entries; }
export async function readText(path: string): Promise<string> {
  return request(fileUrl('/file', path), {}, 15000, async (response) => {
    revisions.set(path, response.headers.get('etag'));
    return response.text();
  });
}
export async function readTextOrNull(path: string): Promise<string | null> {
  try { return await readText(path); } catch (error) { if ((error as { status?: number }).status === 404) { revisions.set(path, null); return null; } throw error; }
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readText(path)); }
export async function readJsonOrNull<T>(path: string): Promise<T | null> { const text = await readTextOrNull(path); return text === null ? null : JSON.parse(text); }
export async function writeText(path: string, content: string): Promise<void> {
  if (!revisions.has(path)) await readTextOrNull(path);
  const revision = revisions.get(path);
  const headers: Record<string, string> = revision ? { 'If-Match': revision } : { 'If-None-Match': '*' };
  await request(fileUrl('/file', path), { method: 'PUT', headers, body: content }, 15000, async (response) => {
    revisions.set(path, response.headers.get('etag'));
    await response.text();
  });
}
export async function writeJson(path: string, value: unknown): Promise<void> { await writeText(path, JSON.stringify(value, null, 2)); }
export async function append(path: string, content: string): Promise<void> {
  await request(fileUrl('/append', path), { method: 'POST', body: content }, 15000, async (response) => {
    revisions.set(path, response.headers.get('etag'));
    await response.text();
  });
}
export async function extractPdf(path: string, start: number, end: number): Promise<{ numPages: number; pages: { page: number; text: string }[] }> {
  return request(`${fileUrl('/extract', path)}&start=${start}&end=${end}`);
}
export async function studyJson<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request(endpoint, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}
