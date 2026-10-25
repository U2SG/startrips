import { fetch as expoFetch } from 'expo/fetch';
import type { Settings } from './settings';
import { writeToken } from './tokenStore';

export type Entry = { name: string; dir: boolean; size: number; mtime: number };
let cfg: Pick<Settings, 'serverUrl' | 'token'> = { serverUrl: '', token: '' };
const revisions = new Map<string, string | null>();
const unauthorized = new Set<() => void>();
export function configureApi(settings: Pick<Settings, 'serverUrl' | 'token'>) {
  if (cfg.serverUrl !== settings.serverUrl || cfg.token !== settings.token) revisions.clear();
  cfg = settings;
}
export function serverCfg() { return cfg; }
export function onUnauthorized(listener: () => void) { unauthorized.add(listener); return () => { unauthorized.delete(listener); }; }
export function clearCredentials() { cfg = { ...cfg, token: '' }; revisions.clear(); }

export async function authFetch(endpoint: string, init: RequestInit = {}): Promise<Response> {
  const current = cfg;
  const headers = new Headers(init.headers);
  if (current.token) headers.set('Authorization', `Bearer ${current.token}`);
  const response = await expoFetch(`${current.serverUrl}${endpoint}`, { ...init, headers, credentials: 'include' });
  const refreshed = response.headers.get('set-auth-token');
  if (refreshed && current === cfg) { cfg = { ...cfg, token: refreshed }; await writeToken(cfg.serverUrl, refreshed); }
  if (response.status === 401 && !endpoint.startsWith('/api/auth/')) unauthorized.forEach((listener) => listener());
  return response;
}

export async function request(endpoint: string, init: RequestInit = {}, timeoutMs = 180000): Promise<Response> {
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
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请检查网络后重试');
    throw error;
  } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}

const fileUrl = (endpoint: string, path: string) => `${endpoint}?path=${encodeURIComponent(path)}`;
export async function ping(): Promise<{ ok: boolean; root: string }> { return (await request('/ping', {}, 15000)).json(); }
export async function list(path: string): Promise<Entry[]> { return (await (await request(fileUrl('/list', path), {}, 15000)).json()).entries; }
export async function readText(path: string): Promise<string> {
  const response = await request(fileUrl('/file', path), {}, 15000);
  revisions.set(path, response.headers.get('etag'));
  return response.text();
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
  const response = await request(fileUrl('/file', path), { method: 'PUT', headers, body: content }, 15000);
  revisions.set(path, response.headers.get('etag'));
}
export async function writeJson(path: string, value: unknown): Promise<void> { await writeText(path, JSON.stringify(value, null, 2)); }
export async function append(path: string, content: string): Promise<void> {
  const response = await request(fileUrl('/append', path), { method: 'POST', body: content }, 15000);
  revisions.set(path, response.headers.get('etag'));
}
export async function extractPdf(path: string, start: number, end: number): Promise<{ numPages: number; pages: { page: number; text: string }[] }> {
  return (await request(`${fileUrl('/extract', path)}&start=${start}&end=${end}`)).json();
}
export async function studyJson<T>(endpoint: string, body?: unknown): Promise<T> {
  return (await request(endpoint, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}
