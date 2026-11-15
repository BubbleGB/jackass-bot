import type { BotRequest,ContextMessage } from '../domain/types.js';
import type { HistorySource } from './types.js';
import { prefix } from '../knowledge/text.js';
export const nameLimits = { characters: 80,participants: 16,concurrency: 4,deadlineMs: 2000 } as const;
export function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.isWellFormed()) return undefined;
  const name = prefix(value.replace(/[\p{Cc}\p{Bidi_Control}]/gu,'').trim(),nameLimits.characters); return name || undefined;
}
const record = (v: unknown): Record<string,unknown> => v && typeof v === 'object' ? v as Record<string,unknown> : {};
export function discordName(member: unknown,author: unknown): string | undefined {
  const m = record(member),u = record(author); return safeName(m.nick) ?? safeName(m.nickname) ?? safeName(u.global_name) ?? safeName(u.username);
}
/** Best-effort names only: no permissions are cached or inferred from these labels. */
export async function nameContext(history: HistorySource,r: BotRequest,context: ContextMessage[],known: ReadonlySet<string>,parent: AbortSignal): Promise<ContextMessage[]> {
  if (!history.resolveName) return context;
  const ids = [...new Set([r.userId,...context.slice().reverse().map(c => c.authorId)])].filter(id => !known.has(id) && context.some(c => c.authorId === id)).slice(0,nameLimits.participants);
  if (!ids.length) return context;
  const controller = new AbortController(),signal = AbortSignal.any([parent,controller.signal]),names = new Map<string,string>(); let next = 0,timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    while (!signal.aborted) { const id = ids[next++]; if (!id) return; try { const name = safeName(await history.resolveName!(r,id,signal)); if (name && !signal.aborted) names.set(id,name); } catch { /* Fall back to message username/ID; never weaken access. */ } }
  };
  try { await Promise.race([Promise.allSettled(Array.from({ length: Math.min(ids.length,nameLimits.concurrency) },work)),new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); },nameLimits.deadlineMs); })]); }
  finally { clearTimeout(timer); controller.abort(); }
  return context.map(c => { const name = names.get(c.authorId) ?? safeName(c.displayName); return name ? { ...c,displayName: name } : c; });
}
