import { describe,it,expect,vi } from 'vitest';
import { nameContext,safeName,discordName,nameLimits } from '../../src/conversation/names.js';
import { ContextBuilder } from '../../src/conversation/context.js';
import { request,settings,source,instant,user } from '../helpers/conversation.js';
import type { ContextMessage } from '../../src/domain/types.js';
describe('bounded ephemeral participant labels',() => {
  it('prefers server nickname then display name then username and strips controls without changing IDs',() => {
    expect(discordName({ nick: 'Nova' },{ global_name: 'Global',username: 'user' })).toBe('Nova');
    expect(discordName({ nick: null },{ global_name: 'Global',username: 'user' })).toBe('Global');
    expect(discordName({ nick: '' },{ global_name: null,username: 'user' })).toBe('user');
    expect(safeName('\n\u202eNova 🌌\u2066')).toBe('Nova 🌌'); expect(safeName('\ud800')).toBeUndefined();
    const name = safeName('👨‍👩‍👧‍👦'.repeat(30))!; expect([...name].length).toBeLessThanOrEqual(nameLimits.characters); expect(name.endsWith('\u200d')).toBe(false);
  });
  it('resolves at most sixteen selected IDs, prioritises requester and keeps all context identity fields',async () => {
    const history = source(),calls: string[] = [],context: ContextMessage[] = [user,...Array.from({ length: 24 },(_,i) => String(700000000000000000n+BigInt(i)))].map((authorId,i) => ({ id: String(i+1),authorId,kind: 'human',text: 'hi',timestamp: instant,displayName: 'fallback' }));
    history.resolveName = async (_r,id) => { calls.push(id); return 'Nick '+id; };
    const result = await nameContext(history,request,context,new Set(),new AbortController().signal);
    expect(calls).toHaveLength(16); expect(calls[0]).toBe(user); expect(result.map(c => c.authorId)).toEqual(context.map(c => c.authorId));
    expect(result.filter(c => c.displayName?.startsWith('Nick '))).toHaveLength(16); expect(result.filter(c => c.displayName === 'fallback')).toHaveLength(9);
    history.resolveName = async () => 'Fresh name'; expect((await nameContext(history,request,[context[0]!],new Set(),new AbortController().signal))[0]!.displayName).toBe('Fresh name');
  });
  it('uses trusted-source name metadata for ask without another member lookup',async () => {
    const history = source(); history.resolveName = vi.fn(async () => 'unexpected');
    const context = await new ContextBuilder(history,async () => 100).buildContext({ ...request,source: 'ask',prompt: 'Hi',displayName: 'Nova 🌌' },settings);
    expect(context.at(-1)).toMatchObject({ authorId: user,displayName: 'Nova 🌌',text: 'Hi' }); expect(history.resolveName).not.toHaveBeenCalled();
  });
  it('falls back after its shared deadline and late results cannot mutate a counted context',async () => {
    vi.useFakeTimers();
    try {
      const history = source(); let resolve!: (s: string) => void; history.resolveName = async () => new Promise<string>(r => { resolve = r; });
      const context: ContextMessage[] = [{ id: '1',authorId: user,kind: 'human',text: 'hello',timestamp: instant,displayName: 'fallback' }];
      const pending = nameContext(history,request,context,new Set(),new AbortController().signal); await vi.advanceTimersByTimeAsync(2000); const result = await pending;
      expect(result[0]!.displayName).toBe('fallback'); resolve('Late malicious name'); await Promise.resolve(); expect(result[0]!.displayName).toBe('fallback');
    } finally { vi.useRealTimers(); }
  });
});
