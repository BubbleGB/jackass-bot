let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export class ApiError extends Error { constructor(readonly status: number,readonly code: string) { super(code); } }
export async function api<T>(path: string,method = 'GET',body?: unknown): Promise<T> {
  const r = await fetch(path,{ method,credentials: 'same-origin',signal: AbortSignal.timeout(15000),headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}),...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new ApiError(r.status,b.error ?? 'request_failed'); }
  return r.status === 204 ? undefined as T : r.json();
}
export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Your session expired. Sign in again; your settings draft remains in this tab.';
    if (e.code === 'verification_unavailable') return 'Discord access verification is temporarily unavailable. Try again shortly; your draft is kept in this tab.';
    if (e.code === 'csrf_failed') return 'The security check failed. Reload the page and try again; your draft is kept in this tab.';
    if (e.status === 403) return 'Your current server access was denied. Ask an owner to check your membership, role and the bot’s access.';
    if (e.status === 429) return 'Too many requests. Wait a minute, then try again.';
    if (e.code === 'storage_failed') return 'Server data is temporarily unavailable. Try again shortly; your draft is kept in this tab.';
    if (e.code === 'not_configured') return 'The bot has not initialized this server yet. Ask the owner to check its installation.';
    if (e.code === 'invalid_settings') return 'Check the field limits, supported model and effort, and ensure the answer target does not exceed the generation limit. An enabled server needs a model and positive allowance.';
    if (e.code === 'credential_invalid') return 'Enter a valid provider key. It will only be saved, never returned.';
  }
  return 'This request could not be completed. Your edits are still here. Try again shortly.';
}
export interface Session { userId: string; creator: boolean; csrf: string }
export interface Site { inviteUrl: string; contactUrl: string | null }
