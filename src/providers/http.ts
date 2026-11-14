import type { ProviderError,NormalizedUsage } from '../domain/types.js';
const SAFE_CODES = new Set(['invalid_usage','transport_uncertain','cancelled_before_send','unsupported_model','invalid_input','invalid_output','incomplete_response','input_too_large','unexpected_tools','provider_configuration','provider_rejected','provider_auth','provider_quota','provider_rate_limit','provider_transient','provider_error','invalid_request','request_not_claimed','guild_disabled','configuration_changed','providers_unavailable','credential_invalid','accounting_unavailable']);
export class ProviderFailure extends Error implements ProviderError {
  readonly safeCode: string;
  readonly usage?: NormalizedUsage; readonly retryAfterMs?: number;
  constructor(readonly category: ProviderError['category'],safeCode: string,options: { usage?: NormalizedUsage; retryAfterMs?: number; notSent?: boolean } = {}) {
    super(SAFE_CODES.has(safeCode) ? safeCode : 'provider_error'); this.safeCode = this.message; this.name = 'ProviderFailure';
    if (options.usage !== undefined) this.usage = options.usage;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.notSent = options.notSent ?? false;
  }
  readonly notSent: boolean;
}
export interface HttpRequest { url: string; headers: Record<string,string>; body: Record<string,unknown>; signal: AbortSignal }
export interface HttpResponse { status: number; headers: Record<string,string>; body: unknown }
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
/** Explicit single HTTP request: no SDK retry/replay, redirects, tools or logging. */
export const fetchTransport: HttpTransport = async request => {
  const response = await fetch(request.url,{ method: 'POST',headers: { 'content-type': 'application/json',...request.headers },body: JSON.stringify(request.body),signal: request.signal,redirect: 'error' });
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 2*1024*1024) throw new Error(); chunks.push(part.value);
    }
  } finally { await reader?.cancel().catch(() => undefined); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return { status: response.status,headers: Object.fromEntries(response.headers),body };
};
export const record = (v: unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
export function tokens(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ProviderFailure('uncertain','invalid_usage');
  return v;
}
export async function send(transport: HttpTransport,request: HttpRequest): Promise<HttpResponse> {
  if (request.signal.aborted) throw new ProviderFailure('transient','cancelled_before_send',{ notSent: true });
  const controller = new AbortController(), signal = AbortSignal.any([request.signal,controller.signal]);
  const timer = setTimeout(() => controller.abort(),60000);
  let abort!: () => void;
  try {
    const cancelled = new Promise<never>((_resolve,reject) => { abort = () => reject(new ProviderFailure('uncertain','transport_uncertain')); signal.addEventListener('abort',abort,{ once: true }); });
    return await Promise.race([transport({ ...request,signal }),cancelled]);
  } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure('uncertain','transport_uncertain'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort',abort); }
}
export function assertHttp(r: HttpResponse,usage?: NormalizedUsage): void {
  if (r.status >= 200 && r.status < 300) return;
  const code = String(record(record(r.body).error).code ?? '').toLowerCase();
  const retry = r.headers['retry-after']; let retryAfterMs: number | undefined;
  if (retry !== undefined) {
    const ms = /^\d+(\.\d+)?$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
    if (Number.isFinite(ms) && ms > 0) retryAfterMs = Math.min(ms,8640000000000000);
  }
  const details = record(record(r.body).error).details;
  if (Array.isArray(details)) for (const value of details) {
    const info = record(value);
    if (info['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof info.retryDelay === 'string' && /^\d+(\.\d+)?s$/.test(info.retryDelay)) {
      const ms = Number(info.retryDelay.slice(0,-1))*1000;
      if (Number.isFinite(ms) && ms > 0) retryAfterMs = Math.max(retryAfterMs ?? 0,Math.min(ms,8640000000000000));
    }
  }
  const category = r.status === 429 ? (code === 'insufficient_quota' || code === 'quota_exceeded' ? 'quota' : 'rate_limit') : r.status === 401 || r.status === 403 ? 'auth' : r.status >= 500 || r.status === 408 ? 'transient' : 'configuration';
  // Only definitive rejection statuses without reported usage release the charge;
  // malformed/partial usage, unknown 400s, 5xx and 408 remain conservative.
  throw new ProviderFailure(category,category === 'configuration' ? (r.status === 404 || ['model_not_found','invalid_model'].includes(code) ? 'provider_configuration' : 'provider_rejected') : `provider_${category}`,{ ...(usage !== undefined ? { usage } : {}),...(retryAfterMs !== undefined ? { retryAfterMs } : {}),notSent: [401,403,404,429].includes(r.status) && record(r.body).usage === undefined });
}
