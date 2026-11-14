import { DiscordRest } from '../../src/discord/transport.js';
export type LookupFault = 'none' | 'slow' | 'burst' | 'rate_limited' | 'timeout' | 'unavailable';
/** Only network boundary is mocked; production REST classification and membership are real. */
export function dashboardDiscord(ids: { guild: string; owner: string; delegate: string; role: string; channel: string; other: string }) {
  const bot = '777777777777777777'; let member = true,hasRole = true,botPresent = true;
  let mode: LookupFault = 'none',at = 1,lookups = 0,reads = 0,activeRoles = 0;
  const rest = new DiscordRest('synthetic-discord-token',async (url,init) => {
    const path = new URL(String(url)).pathname.replace('/api/v10',''); reads++;
    const json = (b: unknown,status = 200) => new Response(JSON.stringify(b),{ status });
    if (path === `/guilds/${ids.guild}`) return json({ id: ids.guild,owner_id: ids.owner,name: 'Bubble Galaxy' });
    if (path === `/guilds/${ids.guild}/roles`) {
      lookups++; const n = lookups; activeRoles++;
      try {
        if ((mode === 'burst' && activeRoles > 1) || (mode === 'rate_limited' && n === at)) return json({ retry_after: 1 },429);
        if (mode === 'timeout' && n === at) return await new Promise<Response>((_resolve,reject) => { const abort = () => reject(new Error('synthetic-abort')); if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort',abort,{ once: true }); });
        if (mode === 'unavailable' && n === at) return json({},502);
        if (mode === 'burst' || mode === 'slow') await new Promise(r => setTimeout(r,40));
        return json([{ id: ids.guild,permissions: '0' },{ id: ids.role,permissions: '0' }]);
      } finally { activeRoles--; }
    }
    if (path.startsWith(`/guilds/${ids.guild}/members/`)) {
      const user = path.split('/').at(-1)!;
      if (user === bot ? !botPresent : !member) return json({ code: 10007 },404);
      return json({ user: { id: user,bot: user === bot },roles: user === ids.delegate && hasRole ? [ids.role] : [] });
    }
    if (path === `/guilds/${ids.guild}/channels`) return json([{ id: ids.channel,guild_id: ids.guild,type: 0,name: 'general' },{ id: ids.other,guild_id: ids.guild,type: 11,name: 'excluded thread' }]);
    if (path === `/channels/${ids.channel}`) return json({ id: ids.channel,guild_id: ids.guild,type: 0 });
    return json({},404);
  });
  return { bot,get: (path: string,signal: AbortSignal) => rest.call({ method: 'GET',path,signal }),
    fault(next: LookupFault,ordinal = 1) { mode = next; at = ordinal; lookups = 0; reads = 0; },
    trace: () => ({ lookups,discordReads: reads }),
    reset() { member = true; hasRole = true; botPresent = true; mode = 'none'; lookups = 0; reads = 0; },
    leave() { member = false; },removeRole() { hasRole = false; },removeBot() { botPresent = false; },
  };
}
