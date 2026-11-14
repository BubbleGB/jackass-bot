import { describe,it,expect,vi } from 'vitest';
import { ContextBuilder } from '../../src/conversation/context.js';
import { message,source,settings,request,bot,guild,channel } from '../helpers/conversation.js';
import type { GenerationInput } from '../../src/domain/types.js';
const count = async (_provider: unknown,input: GenerationInput) => 100+input.context.reduce((n,c) => n+c.text.length,0);
describe('bounded channel context',() => {
  it('keeps only same-channel human and own-bot text, independently capped and chronological',async () => {
    const history = [message('90','new'),message('80','own',{ authorId: bot,authorBot: true }),message('70','oldown',{ authorId: bot,authorBot: true }),message('60'),message('50'),message('40'),message('99','otherguild',{ guildId: channel }),message('98','otherchannel',{ channelId: guild }),message('97','otherbot',{ authorBot: true }),message('96','webhook',{ webhookId: bot })];
    const result = await new ContextBuilder(source(history),count).buildContext(request,settings);
    expect(result.map(c => c.text)).toEqual(['50','60','own','new','hello']);
    expect(result.filter(c => c.kind === 'human')).toHaveLength(4);
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
  it('reduces optional history oldest first while preserving full required text and instructions',async () => {
    const h = source([message('60','oldest'),message('70','middle'),message('80','new')]);
    h.fetchTrigger = async () => message(request.id,'required input');
    const seen: GenerationInput[] = [];
    const counter = async (_provider: unknown,input: GenerationInput) => { seen.push(input); return 10+input.instructions.length+input.context.reduce((n,c) => n+c.text.length,0); };
    const context = await new ContextBuilder(h,counter).buildContext(request,{ ...settings,contextTokenLimit: 35 });
    expect(context.map(m => m.text)).toEqual(['new','required input']);
    expect(seen.every(i => i.instructions === 'Be kind.' && i.context.filter(c => c.id === request.id).length === 1 && i.context.find(c => c.id === request.id)?.text === 'required input')).toBe(true);
  });
  it.each(['mention','reply','ask'] as const)('zero human history retains the entire current %s once, plus separately capped own-bot history',async sourceType => {
    const h = source([message('80','previous human'),message('70','previous bot',{ authorId: bot,authorBot: true }),message(request.id,'duplicate')]);
    h.fetchTrigger = async () => message(request.id,'full current',{ repliesToBot: true });
    const context = await new ContextBuilder(h,count).buildContext({ ...request,source: sourceType,...(sourceType === 'ask' ? { prompt: 'full current' } : {}) },{ ...settings,humanContextLimit: 0 });
    expect(context.map(c => c.text)).toEqual(['previous bot','full current']);
    expect(context.filter(c => c.kind === 'human')).toHaveLength(1);
  });
  it('zero history of both kinds fetches no previous messages but still includes the request',async () => {
    const h = source(); let pages = 0; h.fetchPage = async () => { pages++; throw new Error('history disabled'); };
    expect((await new ContextBuilder(h,count).buildContext(request,{ ...settings,humanContextLimit: 0,selfContextLimit: 0 })).map(c => c.text)).toEqual(['hello']);
    expect(pages).toBe(0);
  });
  it.each(['instructions','current'] as const)('rejects oversized required %s without shortening either required component',async part => {
    const prompt = part === 'current' ? 'full current request'.repeat(20) : 'Hi';
    const instructions = part === 'instructions' ? 'full server instructions'.repeat(20) : 'Be kind.';
    const seen: GenerationInput[] = [];
    const counter = async (_provider: unknown,input: GenerationInput) => { seen.push(input); return 100+input.instructions.length+input.context.reduce((n,c) => n+c.text.length,0); };
    await expect(new ContextBuilder(source([message('80','optional')]),counter).buildContext({ ...request,source: 'ask',prompt },{ ...settings,instructions,contextTokenLimit: 150 })).rejects.toThrow('input_too_large');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(i => i.instructions === instructions && i.context.find(c => c.id === `ask:${request.id}`)?.text === prompt)).toBe(true);
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
  it('rejects a token budget too small for intact required input',async () => {
    await expect(new ContextBuilder(source(),count).buildContext(request,{ ...settings,contextTokenLimit: 1 })).rejects.toThrow('input_too_large');
  });
  it('builds automatic context without direct eligibility and preserves the newest usable human input',async () => {
    const h = source([message('80','old human'),message('90','new bot',{ authorId: bot,authorBot: true })]);
    const seen: GenerationInput[] = [];
    const result = await new ContextBuilder(h,async (_p,input) => { seen.push(input); return 100+input.context.reduce((n,c) => n+c.text.length,0); }).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,directEnabled: false,contextTokenLimit: 105 });
    expect(result).toMatchObject({ status: 'ready',context: [{ id: request.id,text: 'hello' }] });
    expect(seen.every(i => i.instructions === 'Be kind.' && i.mode === 'auto_conditional')).toBe(true);
  });
  it.each(['instructions','human'] as const)('skips automatic context with a diagnosable reason if required %s cannot fit',async part => {
    const h = source(); const instructions = part === 'instructions' ? 'x'.repeat(8001) : 'Be kind.';
    const result = await new ContextBuilder(h,async () => 200).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,instructions,contextTokenLimit: 100 });
    expect(result).toEqual({ status: 'skipped',reason: 'input_too_large' });
  });
  it('preserves an older usable human message when newer automatic context is blank or own-bot text',async () => {
    const h = source([message('70','human context',{ timestamp: new Date('2026-11-14T11:59:57Z') }),message('80','bot text',{ authorBot: true,authorId: bot,timestamp: new Date('2026-11-14T11:59:58Z') })]);
    h.fetchTrigger = async () => message(request.id,'   ');
    const result = await new ContextBuilder(h,count).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,humanContextLimit: 1,contextTokenLimit: 113 });
    expect(result).toMatchObject({ status: 'ready',context: [{ text: 'human context' }] });
  });
  it('uses older whole human context when the newest automatic message cannot fit',async () => {
    const h = source([message('80','Hi')]); h.fetchTrigger = async () => message(request.id,'long human context'.repeat(100));
    const result = await new ContextBuilder(h,count).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,contextTokenLimit: 105 });
    expect(result).toMatchObject({ status: 'ready',context: [{ text: 'Hi' }] });
  });
  it('ignores an overlong optional automatic trigger while retaining older intact human context',async () => {
    const h = source([message('80','Hi')]); h.fetchTrigger = async () => message(request.id,'x'.repeat(6001));
    const seen: GenerationInput[] = [];
    const result = await new ContextBuilder(h,async (_p,input) => { seen.push(input); return 102; }).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,humanContextLimit: 1,contextTokenLimit: 105 });
    expect(result).toMatchObject({ status: 'ready',context: [{ text: 'Hi' }] });
    expect(seen.every(i => i.context.length === 1 && i.context[0]?.text === 'Hi' && i.instructions === 'Be kind.')).toBe(true);
  });
  it('labels the automatic sizing work limit honestly rather than claiming every context was checked',async () => {
    let counts = 0;
    const h = source(Array.from({ length: 100 },(_,i) => message(String(100+i),'whole human message')));
    const result = await new ContextBuilder(h,async () => { counts++; return 200; }).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,humanContextLimit: 100,selfContextLimit: 0,contextTokenLimit: 100 });
    expect(result).toEqual({ status: 'skipped',reason: 'context_check_limit' }); expect(counts).toBe(24);
  });
  it('does not assess automatic requests using only instructions or its own bot text',async () => {
    let counts = 0;
    const h = source([message('70','own bot',{ authorId: bot,authorBot: true })]);
    const result = await new ContextBuilder(h,async () => { counts++; return 100; }).buildAutomaticContext({ ...request,source: 'automatic' },{ ...settings,humanContextLimit: 0 });
    expect(result).toEqual({ status: 'skipped',reason: 'no_usable_context' }); expect(counts).toBe(0);
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
