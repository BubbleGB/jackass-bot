import { describe,it,expect } from 'vitest';
import { DirectEligibility } from '../../src/conversation/eligibility.js';
import { DirectService } from '../../src/conversation/direct.js';
import { ContextBuilder } from '../../src/conversation/context.js';
import { settings,request,source,instant,guild,channel,user,message } from '../helpers/conversation.js';
import type { GenerationResult,GenerationInput } from '../../src/domain/types.js';
const reported = { inputTokens: 10,outputTokens: 2,reasoningTokens: 0,totalTokens: 12,certainty: 'reported' as const };
const result: GenerationResult = { kind: 'answer',text: 'hi',usage: reported };
function fixture() {
  let time = instant.getTime(),config = structuredClone(settings),allowed = true,calls = 0;
  const history = source(); history.canRead = async () => allowed;
  const repository = { async load(id: string) { return id === config.guildId ? structuredClone(config) : null; } };
  const gate = new DirectEligibility(repository,history,() => new Date(time));
  const context = new ContextBuilder(history,async () => 100);
  let generate: (input: GenerationInput) => Promise<GenerationResult> = async () => result;
  const provider = { async generateWithFallback(r: typeof request,input: GenerationInput,revision?: number) { calls++; expect(r.guildId).toBe(guild); expect(revision).toBe(config.revision); return generate(input); } };
  const service = new DirectService(gate,repository,history,context,provider);
  return { gate,service,history,repository,config,setConfig(c: typeof settings) { config = c; },setAllowed(v: boolean) { allowed = v; },advance(n: number) { time += n; },setGenerate(g: typeof generate) { generate = g; },calls() { return calls; } };
}
describe('server-wide direct request eligibility and lifecycle',() => {
  it('enforces 4,999/5,000 ms across channels; users and guilds remain independent',async () => {
    const f = fixture(); expect((await f.service.handleDirect(request)).status).toBe('accepted');
    f.advance(4999);
    expect(await f.gate.acceptDirect({ ...request,channelId: user })).toBe('cooldown');
    expect(await f.gate.acceptDirect({ ...request,userId: channel,source: 'ask',prompt: 'hello' })).toBe('accepted');
    f.repository.load = async id => [guild,channel].includes(id) ? { ...settings,guildId: id } : null;
    expect(await f.gate.acceptDirect({ ...request,guildId: channel,source: 'ask',prompt: 'hi' })).toBe('accepted');
    f.advance(1); expect(await f.gate.acceptDirect({ ...request,channelId: user,source: 'ask',prompt: 'hey' })).toBe('accepted');
  });
  it('admits only one user request across concurrent async checks and retains busy after cooldown',async () => {
    const f = fixture();
    const statuses = await Promise.all([f.gate.acceptDirect(request),f.gate.acceptDirect(request)]);
    expect(statuses.filter(s => s === 'accepted')).toHaveLength(1);
    f.advance(5000); expect(await f.gate.acceptDirect({ ...request,channelId: user })).toBe('busy');
  });
  it('does not release a newer outstanding request when an old request finishes twice',async () => {
    const f = fixture(); expect((await f.service.handleDirect(request)).status).toBe('accepted'); f.advance(5000);
    const next = { ...request,id: '555555555555555556',source: 'ask' as const,prompt: 'hey' };
    expect(await f.gate.acceptDirect(next)).toBe('accepted');
    f.gate.completeDirect(request); f.advance(5000); expect(await f.gate.acceptDirect(request)).toBe('busy');
  });
  it.each(['answer','silence','refusal','failure'] as const)('cleans outstanding state after %s while preserving the acceptance cooldown',async kind => {
    const f = fixture();
    f.setGenerate(async () => { if (kind === 'failure') throw new Error('private chat fake-key'); return kind === 'silence' ? { kind,usage: reported } : { kind,text: 'safe',usage: reported }; });
    if (kind === 'failure') await expect(f.service.handleDirect(request)).rejects.toThrow('direct_failed');
    else expect((await f.service.handleDirect(request)).status).toBe('accepted');
    expect(await f.gate.acceptDirect(request)).toBe('cooldown'); f.advance(5000);
    expect(await f.gate.acceptDirect(request)).toBe('accepted');
  });
  it.each(['hi','yo','sup?','lol','helo freind','👍','bonjour','привет'])('does not classify %s as gibberish or fabricate trusted instructions',async prompt => {
    const f = fixture(); let seen: GenerationInput | undefined;
    f.setGenerate(async input => { seen = input; return result; });
    expect((await f.service.handleDirect({ ...request,source: 'ask',prompt })).status).toBe('accepted');
    expect(f.calls()).toBe(1); expect(seen?.context.filter(c => c.text === prompt)).toHaveLength(1); expect(seen?.instructions).toBe('Be kind.');
  });
  it('rejects disabled/unapproved config, spoofed guilds, lost permissions and nonhuman triggers before providers',async () => {
    for (const mode of ['disabled','switch','guild','permissions','bot','webhook','not-mentioned'] as const) {
      const f = fixture();
      if (mode === 'disabled') f.config.enabled = false;
      if (mode === 'switch') f.config.directEnabled = false;
      if (mode === 'guild') f.config.guildId = channel;
      if (mode === 'permissions') f.setAllowed(false);
      if (mode === 'bot') f.history.fetchTrigger = async () => message(request.id,'x',{ authorBot: true });
      if (mode === 'webhook') f.history.fetchTrigger = async () => message(request.id,'x',{ webhookId: user });
      if (mode === 'not-mentioned') f.history.fetchTrigger = async () => message(request.id,'x',{ mentionsBot: false });
      expect((await f.service.handleDirect(request)).status).not.toBe('accepted'); expect(f.calls()).toBe(0);
    }
  });
  it('stops on permission/config changes during context work, cleaning outstanding state',async () => {
    for (const mode of ['permission','revision'] as const) {
      const f = fixture();
      f.history.fetchPage = async () => { if (mode === 'permission') f.setAllowed(false); else f.config.revision++; return { messages: [],before: null }; };
      await expect(f.service.handleDirect(request)).rejects.toThrow(); expect(f.calls()).toBe(0);
      f.advance(5000); f.setAllowed(true); expect(await f.gate.acceptDirect(request)).toBe('accepted');
    }
  });
  it('cleans up after context failure and rejects invalid or empty direct requests',async () => {
    const f = fixture(); f.history.fetchPage = async () => { throw new Error('private history'); };
    await expect(f.service.handleDirect(request)).rejects.toThrow('context_unavailable'); f.advance(5000); expect(await f.gate.acceptDirect(request)).toBe('accepted');
    for (const bad of [{ ...request,guildId: '' },{ ...request,source: 'automatic' as const },{ ...request,source: 'ask' as const,prompt: '  ' }]) expect(await fixture().gate.acceptDirect(bad)).toBe('unsupported');
  });
});
