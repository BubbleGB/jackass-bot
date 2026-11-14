import { describe,it,expect,vi } from 'vitest';
import { ContextBuilder } from '../../src/conversation/context.js';
import { message,source,settings,request,bot,guild,channel } from '../helpers/conversation.js';
import type { GenerationInput } from '../../src/domain/types.js';
const count = async (_provider: unknown,input: GenerationInput) => 100+input.context.reduce((n,c) => n+c.text.length,0);
describe('bounded channel context',() => {
  it('keeps only same-channel human and own-bot text, independently capped and chronological',async () => {
    const history = [message('90','new'),message('80','own',{ authorId: bot,authorBot: true }),message('70','oldown',{ authorId: bot,authorBot: true }),message('60'),message('50'),message('40'),message('99','otherguild',{ guildId: channel }),message('98','otherchannel',{ channelId: guild }),message('97','otherbot',{ authorBot: true }),message('96','webhook',{ webhookId: bot })];
    const result = await new ContextBuilder(source(history),count).buildContext(request,settings);
    expect(result.map(c => c.text)).toEqual(['60','own','new','hello']);
    expect(result.filter(c => c.kind === 'human')).toHaveLength(3);
    expect(result.filter(c => c.kind === 'self')).toHaveLength(1);
  });
  it('takes a chronological snapshot ending at the trigger rather than including later messages',async () => {
    const h = source([message('80','before',{ timestamp: new Date('2026-11-14T11:59:57Z') }),message('90','after',{ timestamp: new Date('2026-11-14T11:59:59Z') })]);
    h.fetchTrigger = async () => message(request.id,'hello',{ timestamp: new Date('2026-11-14T11:59:58Z') });
    expect((await new ContextBuilder(h,count).buildContext(request,settings)).map(m => m.text)).toEqual(['before','hello']);
  });
  it('deduplicates the trigger, using fresh content once even if history repeats it',async () => {
    const history = [message(request.id,'stale'),message(request.id,'stale again'),message('80','earlier')];
    const context = await new ContextBuilder(source(history),count).buildContext(request,settings);
    expect(context.map(c => c.text)).toEqual(['earlier','hello']);
    expect(context.filter(c => c.id === request.id)).toHaveLength(1);
  });
  it('inserts an ask prompt exactly once and does not mistake its interaction ID for a message',async () => {
    const history = source([message(request.id,'unrelated history')]);
    history.fetchTrigger = async () => { throw new Error('must not fetch an interaction as message'); };
    const context = await new ContextBuilder(history,count).buildContext({ ...request,source: 'ask',prompt: 'sup?' },settings);
    expect(context.map(c => c.text)).toEqual(['unrelated history','sup?']);
    expect(context.filter(c => c.id === `ask:${request.id}`)).toHaveLength(1);
  });
  it('drops oldest history then suffix-trims required input to fit complete counted input',async () => {
    const history = source([message('80','old context')]);
    history.fetchTrigger = async () => message(request.id,'1234567890newest');
    const result = await new ContextBuilder(history,count).buildContext(request,{ ...settings,contextTokenLimit: 107 });
    expect(result).toHaveLength(1); expect(result[0]!.id).toBe(request.id);
    expect(result[0]!.text.endsWith('newest')).toBe(true); expect(result[0]!.text.length).toBeLessThanOrEqual(7);
  });
  it('checks full instructions/context/effort/generation against every funded selected model',async () => {
    const seen: GenerationInput[] = [];
    const builder = new ContextBuilder(source(),async (provider,input) => { seen.push(input); return provider === 'google' ? 106 : 101; });
    const providers = [...settings.providers,{ ...settings.providers[0]!,provider: 'google' as const,modelId: 'gemini-3.5-flash-lite',effort: 'minimal',priority: 2 }];
    expect(await builder.buildContext(request,{ ...settings,providers,contextTokenLimit: 106 })).toHaveLength(1);
    expect(seen.map(i => i.modelId)).toEqual(['gpt-5.4-mini-2026-03-17','gemini-3.5-flash-lite']);
    expect(seen.every(i => i.instructions === 'Be kind.' && i.maxGenerationTokens === 2048 && i.context[0]?.text === 'hello')).toBe(true);
    await expect(builder.buildContext(request,{ ...settings,contextTokenLimit: 399000,maxGenerationTokens: 2048 })).rejects.toThrow();
  });
  it.each([0,1])('fails closed when cap/budget %i cannot preserve required input',async n => {
    await expect(new ContextBuilder(source(),count).buildContext(request,{ ...settings,...(n === 0 ? { humanContextLimit: 0 } : { contextTokenLimit: 1 }) })).rejects.toThrow('context_limit');
  });
  it('never fetches history after permission loss and discards context if permissions disappear during fetch',async () => {
    const h = source(); let pages = 0; h.canRead = async () => false; h.fetchPage = async () => { pages++; return { messages: [],before: null }; };
    await expect(new ContextBuilder(h,count).buildContext(request,settings)).rejects.toThrow('context_unavailable'); expect(pages).toBe(0);
    let checks = 0; h.canRead = async () => ++checks === 1;
    await expect(new ContextBuilder(h,count).buildContext(request,settings)).rejects.toThrow('context_unavailable');
  });
  it.each(['fetch','first-count'])('sends no further context to counters after permission loss during %s',async phase => {
    let allowed = true,calls = 0; const h = source();
    h.canRead = async () => allowed;
    h.fetchPage = async () => { if (phase === 'fetch') allowed = false; return { messages: [],before: null }; };
    const counter = async () => { calls++; if (phase === 'first-count') allowed = false; return 100; };
    const providers = [...settings.providers,{ ...settings.providers[0]!,provider: 'google' as const,modelId: 'gemini-3.5-flash-lite',effort: 'minimal',priority: 2 }];
    await expect(new ContextBuilder(h,counter).buildContext(request,{ ...settings,providers })).rejects.toThrow('context_unavailable');
    expect(calls).toBe(phase === 'fetch' ? 0 : 1);
  });
  it('bounds pages and stops on a repeated cursor even when history is mostly bots',async () => {
    const h = source(); let pages = 0;
    h.fetchPage = async () => { pages++; return { messages: Array.from({ length: 100 },(_,i) => message(String(1000-i),'ignored',{ authorBot: true })),before: '901' }; };
    expect(await new ContextBuilder(h,count).buildContext(request,settings)).toHaveLength(1); expect(pages).toBeLessThanOrEqual(3);
  });
  it('scans no more than three distinct full pages when only other bots are present',async () => {
    const h = source(); let pages = 0;
    h.fetchPage = async () => { const base = 1000-(++pages)*100; return { messages: Array.from({ length: 100 },(_,i) => message(String(base-i),'ignored',{ authorBot: true })),before: String(base-99) }; };
    expect(await new ContextBuilder(h,count).buildContext(request,settings)).toHaveLength(1); expect(pages).toBe(3);
  });
  it('does not start another provider count after a hung counter resolves past the context deadline',async () => {
    vi.useFakeTimers();
    try {
      let calls = 0,release!: (n: number) => void;
      const builder = new ContextBuilder(source(),async () => { calls++; if (calls === 1) return new Promise<number>(resolve => { release = resolve; }); return 100; });
      const providers = [...settings.providers,{ ...settings.providers[0]!,provider: 'google' as const,modelId: 'gemini-3.5-flash-lite',effort: 'minimal',priority: 2 }];
      const pending = builder.buildContext(request,{ ...settings,providers }).catch(e => String(e));
      await vi.advanceTimersByTimeAsync(20000); expect(await pending).toBe('ConversationError: context_unavailable');
      release(100); await vi.advanceTimersByTimeAsync(0); expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('bounds an uncooperative history fetch and redacts raw errors',async () => {
    vi.useFakeTimers();
    try {
      const h = source(); h.fetchPage = async () => new Promise(() => undefined);
      const pending = new ContextBuilder(h,count).buildContext(request,settings).catch(e => String(e));
      await vi.advanceTimersByTimeAsync(20000); expect(await pending).toBe('ConversationError: context_unavailable');
    } finally { vi.useRealTimers(); }
    const h = source(); h.fetchPage = async () => { throw new Error('private chat fake-key'); };
    await expect(new ContextBuilder(h,count).buildContext(request,settings)).rejects.toThrow('context_unavailable');
  });
});
