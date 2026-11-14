import type { BotRequest } from '../domain/types.js';
import { contextOperation,conversationLimits,humanTrigger,validRequest,type ConversationConfigRepository,type HistorySource } from './types.js';
export type DirectAcceptance = 'accepted' | 'cooldown' | 'disabled' | 'unsupported' | 'busy';
interface Entry { id: string; acceptedAt: number; outstanding: boolean }
/** One instance per application. In-memory metadata only; single worker is required. */
export class DirectEligibility {
  private readonly entries = new Map<string,Entry>();
  constructor(private readonly config: ConversationConfigRepository,private readonly history: HistorySource,private readonly now: () => Date = () => new Date()) {}
  async acceptDirect(request: BotRequest,now?: Date): Promise<DirectAcceptance> {
    if (!validRequest(request)) return 'unsupported';
    const r = structuredClone(request),key = `${r.guildId}:${r.userId}`;
    const status = (time: number): DirectAcceptance | null => { const entry = this.entries.get(key); return entry?.outstanding ? 'busy' : entry && time-entry.acceptedAt < conversationLimits.directCooldownMs ? 'cooldown' : null; };
    const initial = status((now ?? this.now()).getTime()); if (initial) return initial;
    try {
      return await contextOperation(async signal => {
        const settings = await this.config.load(r.guildId);
        if (signal.aborted) return 'unsupported';
        if (!settings || settings.guildId !== r.guildId || !settings.enabled || !settings.directEnabled) return 'disabled';
        if (!await this.history.canRead(r,signal)) return 'unsupported';
        if (signal.aborted) return 'unsupported';
        if (r.source !== 'ask' && !humanTrigger(await this.history.fetchTrigger(r,signal),r)) return 'unsupported';
        const time = (now ?? this.now()).getTime(); if (!Number.isFinite(time) || signal.aborted) return 'unsupported';
        // No await between recheck and insertion: concurrent eligibility lookups cannot
        // admit two outstanding requests for the same user in this process.
        const current = status(time); if (current) return current;
        if (this.entries.size >= conversationLimits.maxGateEntries) {
          for (const [id,e] of this.entries) if (!e.outstanding && time-e.acceptedAt >= conversationLimits.directCooldownMs) this.entries.delete(id);
          if (this.entries.size >= conversationLimits.maxGateEntries) return 'busy';
        }
        this.entries.set(key,{ id: r.id,acceptedAt: time,outstanding: true });
        return 'accepted';
      });
    } catch { return 'unsupported'; }
  }
  completeDirect(request: BotRequest): void {
    const entry = this.entries.get(`${request.guildId}:${request.userId}`);
    if (entry?.id === request.id) entry.outstanding = false;
  }
}
