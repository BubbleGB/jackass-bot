import type { BotRequest } from '../domain/types.js';
import type { AccessPolicy } from '../access/policy.js';
import { isSnowflake,SettingsError } from '../access/policy.js';
import type { AutomaticService,ScheduledOutcome } from '../conversation/automatic.js';
import type { DirectOutcome } from '../conversation/direct.js';
import { DiscordDelivery,type InteractionTarget,type DeliveryReport } from './delivery.js';
import { discordBounded,noMentions,type DiscordTransport } from './transport.js';
import { COMMANDS,HELP,type UsageStatus } from './commands.js';
export interface DiscordMessageEvent { id: string; guildId: string | null; channelId: string; channelType: number; userId: string; bot: boolean; webhookId: string | null }
export interface DiscordInteraction { id: string; applicationId: string; token: string; guildId?: string; channelId: string; userId: string; channelType: number; command: string; prompt?: string; displayName?: string }
interface Dependencies {
  transport: DiscordTransport; worker: Pick<AutomaticService,'observeMessage' | 'submitDirect'>; access: Pick<AccessPolicy,'require'>;
  status: { getUsageStatus(actorId: string,guildId: string,now: Date): Promise<UsageStatus> }; publicOrigin: string;
  canDeliver: (r: BotRequest,signal: AbortSignal) => Promise<boolean>; now?: () => Date;
  delivery?: DiscordDelivery; onDelivery?: (r: BotRequest,report: DeliveryReport) => void;
}
export class DiscordHandlers {
  private readonly delivery: DiscordDelivery; private readonly now: () => Date;
  private readonly notices = new Map<string,number>();
  private readonly typing = new Map<string,{ interval: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout>; controller: AbortController }>();
  private readonly interactions = new Map<string,{ interaction: DiscordInteraction; handled: boolean }>();
  private stopped = false;
  constructor(private readonly deps: Dependencies) { this.delivery = deps.delivery ?? new DiscordDelivery(deps.transport,deps.canDeliver); this.now = deps.now ?? (() => new Date()); }
  private typingKey(r: BotRequest): string { return `${r.guildId}:${r.channelId}:${r.id}`; }
  beginTyping(r: BotRequest): void {
    if (this.stopped || r.source === 'ask' || this.typing.has(this.typingKey(r))) return;
    const key = this.typingKey(r),controller = new AbortController();
    const refresh = async () => { try { if (await this.deps.canDeliver(r,controller.signal) && !controller.signal.aborted) await this.deps.transport.call({ method: 'POST',path: `/channels/${r.channelId}/typing`,signal: AbortSignal.any([controller.signal,AbortSignal.timeout(2500)]) }); } catch { /* Typing is best effort and never retried through AI. */ } };
    const interval = setInterval(() => { void refresh(); },8000),expiry = setTimeout(() => this.endTyping(r),180000);
    this.typing.set(key,{ interval,expiry,controller }); void refresh();
  }
  endTyping(r: BotRequest): void { const key = this.typingKey(r),entry = this.typing.get(key); if (entry) { clearInterval(entry.interval); clearTimeout(entry.expiry); entry.controller.abort(); this.typing.delete(key); } }
  stop(): void { this.stopped = true; for (const entry of this.typing.values()) { clearInterval(entry.interval); clearTimeout(entry.expiry); entry.controller.abort(); } this.typing.clear(); }
  async handleMessage(event: DiscordMessageEvent): Promise<void> {
    if (this.stopped || event.bot || event.webhookId || event.channelType !== 0 || ![event.id,event.guildId,event.channelId,event.userId].every(isSnowflake)) return;
    await this.deps.worker.observeMessage({ id: event.id,guildId: event.guildId!,channelId: event.channelId,userId: event.userId,source: 'automatic',receivedAt: this.now() });
  }
  async handleOutcome(r: BotRequest,outcome: ScheduledOutcome): Promise<void> {
    if (this.stopped) return;
    try {
      if (r.source === 'ask') {
        const pending = this.interactions.get(r.id); if (!pending || pending.handled) return; pending.handled = true;
        if (outcome.kind === 'direct') await this.slashOutcome(pending.interaction,r,outcome.outcome);
        else await this.unavailable(pending.interaction,r,true);
        return;
      }
      if (outcome.kind === 'result') await this.answer(r,outcome.result,outcome.participantIds ?? []);
      else if (outcome.kind === 'direct') await this.directOutcome(r,outcome.outcome);
      else if (r.source !== 'automatic' && this.allowNotice(r)) await this.delivery.deliverAnswer(r,'AI is currently unavailable or its usage allowance is exhausted. Please try later.',[]);
    } finally { this.endTyping(r); }
  }
  private allowNotice(r: BotRequest): boolean {
    const key = `${r.guildId}:${r.channelId}`,time = this.now().getTime(),previous = this.notices.get(key);
    if (previous !== undefined && time-previous < 60000) return false;
    if (this.notices.size >= 10000) { for (const [k,t] of this.notices) if (time-t >= 60000) this.notices.delete(k); if (this.notices.size >= 10000) return false; }
    this.notices.set(key,time); return true;
  }
  private async answer(r: BotRequest,result: Extract<DirectOutcome,{ status: 'accepted' }>['result'],participants: readonly string[],target?: InteractionTarget): Promise<DeliveryReport | undefined> {
    if (result.kind === 'silence') return;
    const report = await this.delivery.deliverAnswer(r,result.text,participants,target); this.deps.onDelivery?.(r,report); return report;
  }
  private async directOutcome(r: BotRequest,outcome: DirectOutcome): Promise<void> {
    if (outcome.status === 'accepted') await this.answer(r,outcome.result,outcome.participantIds ?? []);
    else if (!['cooldown','busy'].includes(outcome.status) && this.allowNotice(r)) await this.delivery.deliverAnswer(r,outcome.status === 'input_too_large' ? outcome.message : 'Direct responses are currently unavailable.',[]);
  }
  private original(i: DiscordInteraction): string { return `/webhooks/${i.applicationId}/${encodeURIComponent(i.token)}/messages/@original`; }
  private async edit(i: DiscordInteraction,content: string): Promise<void> { await this.deps.transport.call({ method: 'PATCH',path: this.original(i),body: { content,allowed_mentions: noMentions() },signal: AbortSignal.timeout(5000) }); }
  private async privateNotice(i: DiscordInteraction,text: string,publicDefer: boolean,removePlaceholder = true): Promise<void> {
    if (!publicDefer) { await this.edit(i,text); return; }
    if (removePlaceholder) {
      // Fulfil the public defer first: Discord's legacy first-followup path can ignore
      // an ephemeral flag and edit the original. Never put private text on that path.
      await this.edit(i,'Request acknowledged.');
      try { await this.deps.transport.call({ method: 'DELETE',path: this.original(i),signal: AbortSignal.timeout(5000) }); } catch { /* A neutral acknowledgement may remain; the private followup is independent. */ }
    }
    await this.deps.transport.call({ method: 'POST',path: `/webhooks/${i.applicationId}/${encodeURIComponent(i.token)}?wait=true`,body: { content: text,flags: 64,allowed_mentions: noMentions() },signal: AbortSignal.timeout(5000) });
  }
  private async slashOutcome(i: DiscordInteraction,r: BotRequest,outcome: DirectOutcome): Promise<void> {
    if (outcome.status === 'accepted' && outcome.result.kind !== 'silence') {
      const report = await this.answer(r,outcome.result,outcome.participantIds ?? [],{ applicationId: i.applicationId,token: i.token });
      if (report?.state === 'uncertain' && report.deliveredMessageIds.length === 0) return; // Unknown original response: do not overwrite or invoke first-followup compatibility behaviour.
      if (report && report.state !== 'delivered') await this.privateNotice(i,'Delivery could not be completed or confirmed. No answer was regenerated.',true,report.deliveredMessageIds.length === 0 && report.state !== 'uncertain');
      return;
    }
    const text = outcome.status === 'cooldown' ? 'Direct-request cooldown: please wait five seconds.' : outcome.status === 'busy' ? 'You already have a request outstanding.' : outcome.status === 'input_too_large' ? outcome.message : outcome.status === 'accepted' ? 'No response was needed for this request.' : 'Direct responses are currently unavailable.';
    await this.privateNotice(i,text,true);
  }
  private async unavailable(i: DiscordInteraction,r: BotRequest,publicDefer: boolean): Promise<void> {
    const text = 'AI is currently unavailable or its usage allowance is exhausted. Please try later.';
    if (publicDefer && this.allowNotice(r)) { const report = await this.delivery.deliverAnswer(r,text,[],{ applicationId: i.applicationId,token: i.token }); if (report.state === 'uncertain' && report.deliveredMessageIds.length === 0) return; if (report.state !== 'delivered') await this.privateNotice(i,text,true,report.state !== 'uncertain' && report.deliveredMessageIds.length === 0); }
    else await this.privateNotice(i,text,publicDefer);
  }
  async handleInteraction(i: DiscordInteraction): Promise<void> {
    if (this.stopped || !COMMANDS.some(c => c.name === i.command) || ![i.id,i.applicationId,i.channelId,i.userId].every(isSnowflake) || !i.token) return;
    const supported = isSnowflake(i.guildId) && i.channelType === 0,publicDefer = supported && i.command === 'ask';
    try {
      const signal = AbortSignal.timeout(2500);
      await discordBounded(() => this.deps.transport.call({ method: 'POST',path: `/interactions/${i.id}/${encodeURIComponent(i.token)}/callback`,body: { type: 5,data: { flags: publicDefer ? 0 : 64 } },signal }),signal);
    } catch { return; } // Unknown acknowledgement: never begin paid work or ack again blindly.
    if (!supported) { try { await this.edit(i,'Use commands in an ordinary server text channel.'); } catch { /* Safe no-op. */ } return; }
    const r: BotRequest = { id: i.id,guildId: i.guildId!,channelId: i.channelId,userId: i.userId,source: 'ask',prompt: i.prompt ?? i.command,...(i.displayName ? { displayName: i.displayName } : {}),receivedAt: this.now() };
    let resolved = false;
    try {
      if (i.command === 'help') { await this.edit(i,`${HELP}\n${this.deps.publicOrigin}`); return; }
      if (i.command === 'settings' || i.command === 'status') {
        await this.deps.access.require(i.userId,i.guildId!,'read');
        if (i.command === 'settings') await this.edit(i,`Private server settings: ${this.deps.publicOrigin}/servers/${i.guildId}`);
        else { const s = await this.deps.status.getUsageStatus(i.userId,i.guildId!,this.now()); await this.edit(i,`UTC reset: ${s.resetAt}\n`+s.providers.map(p => `${p.provider}: ${p.modelId ?? 'not selected'}; ${p.availability}; remaining ${p.remaining}; used ${p.total}; uncertain ${p.uncertain}; reserved ${p.reserved}; requests ${p.requests}`).join('\n')); }
        return;
      }
      const pending = { interaction: i,handled: false }; this.interactions.set(i.id,pending);
      const outcome = await this.deps.worker.submitDirect(r); resolved = true;
      if (!pending.handled) { pending.handled = true; await this.slashOutcome(i,r,outcome); }
    } catch (e) {
      if (resolved || this.interactions.get(i.id)?.handled) return; // Never overwrite delivered chunks after a delivery/notice failure.
      try {
        if (e instanceof SettingsError && e.code === 'forbidden') await this.privateNotice(i,'You do not have current access to this server command.',publicDefer);
        else if (e instanceof SettingsError && e.code === 'verification_unavailable') await this.privateNotice(i,'Discord access verification is temporarily unavailable. Please try again shortly.',publicDefer);
        else await this.unavailable(i,r,publicDefer);
      } catch { /* Transport failures never cause regeneration or secret-bearing logs. */ }
    } finally { this.interactions.delete(i.id); }

  }
}
