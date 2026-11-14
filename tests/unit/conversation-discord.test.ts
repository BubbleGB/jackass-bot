import { describe,it,expect } from 'vitest';
import { DiscordContextSource } from '../../src/conversation/discord.js';
import { guild,channel,user,bot,request } from '../helpers/conversation.js';
const role = '666666666666666666';
function fixture() {
  const data: Record<string,unknown> = {
    [`/guilds/${guild}`]: { id: guild,owner_id: role },
    [`/guilds/${guild}/members/${user}`]: { user: { id: user,bot: false },roles: [] },
    [`/guilds/${guild}/members/${bot}`]: { user: { id: bot,bot: true },roles: [role] },
    [`/guilds/${guild}/roles`]: [{ id: guild,permissions: '68608' },{ id: role,permissions: '0' }],
    [`/channels/${channel}`]: { id: channel,guild_id: guild,type: 0,permission_overwrites: [] },
    [`/channels/${channel}/messages/${request.id}`]: { id: request.id,channel_id: channel,author: { id: user,bot: false },content: 'hi',timestamp: '2026-11-14T12:00:00Z',type: 0,mentions: [{ id: bot }] },
  };
  const paths: string[] = [];
  const source = new DiscordContextSource(async path => { paths.push(path); return data[path]; },bot);
  return { data,paths,source,signal: new AbortController().signal };
}
describe('current Discord channel permissions and scoped history',() => {
  it('allows current human/bot members with all required channel permissions',async () => {
    const f = fixture(); expect(await f.source.canRead(request,f.signal)).toBe(true);
    expect(await f.source.fetchTrigger(request,f.signal)).toMatchObject({ id: request.id,guildId: guild,channelId: channel,authorId: user,authorBot: false,content: 'hi',mentionsBot: true });
  });
  it.each([1,5,10,11,12,15])('rejects DM/thread/other channel type %i',async type => {
    const f = fixture(); Object.assign(f.data[`/channels/${channel}`]!,{ type }); expect(await f.source.canRead(request,f.signal)).toBe(false);
  });
  it.each(['1024','2048','65536'])('fails closed when bot permission %s is denied by a member overwrite',async deny => {
    const f = fixture(); Object.assign(f.data[`/channels/${channel}`]!,{ permission_overwrites: [{ id: bot,type: 1,allow: '0',deny }] });
    expect(await f.source.canRead(request,f.signal)).toBe(false);
  });
  it('applies everyone then aggregate role then member overwrites; admin bypasses channel denies',async () => {
    const f = fixture(); Object.assign(f.data[`/channels/${channel}`]!,{ permission_overwrites: [{ id: guild,type: 0,deny: '2048',allow: '0' },{ id: role,type: 0,allow: '2048',deny: '0' }] });
    // Human has no allowing role, so cannot submit direct requests here.
    expect(await f.source.canRead(request,f.signal)).toBe(false);
    Object.assign(f.data[`/guilds/${guild}/members/${user}`]!,{ roles: [role] });
    expect(await f.source.canRead(request,f.signal)).toBe(true);
    Object.assign(f.data[`/channels/${channel}`]!,{ permission_overwrites: [{ id: bot,type: 1,deny: '1024',allow: '0' }] });
    f.data[`/guilds/${guild}/roles`] = [{ id: guild,permissions: '68608' },{ id: role,permissions: '8' }];
    expect(await f.source.canRead(request,f.signal)).toBe(true);
  });
  it('rejects bot/webhook/foreign-channel triggers and never downloads a remote reply reference',async () => {
    const f = fixture(), path = `/channels/${channel}/messages/${request.id}`;
    Object.assign(f.data[path]!,{ webhook_id: role }); expect(await f.source.fetchTrigger(request,f.signal)).toBeNull();
    delete (f.data[path] as Record<string,unknown>).webhook_id;
    Object.assign(f.data[path]!,{ channel_id: guild }); expect(await f.source.fetchTrigger(request,f.signal)).toBeNull();
    Object.assign(f.data[path]!,{ channel_id: channel,type: 19,mentions: [],message_reference: { channel_id: guild,message_id: role },referenced_message: { author: { id: bot } } });
    expect((await f.source.fetchTrigger({ ...request,source: 'reply' },f.signal))?.repliesToBot).toBe(false);
    expect(f.paths.every(p => !p.includes(`/channels/${guild}/`))).toBe(true);
  });
  it('retrieves only the requested channel page with a bounded limit and cursor',async () => {
    const f = fixture(),path = `/channels/${channel}/messages?limit=100&before=${request.id}`;
    f.data[path] = [f.data[`/channels/${channel}/messages/${request.id}`]];
    expect((await f.source.fetchPage(request,request.id,100,f.signal)).messages).toHaveLength(1);
    expect(f.paths).toEqual([path]);
    await expect(f.source.fetchPage(request,'not-a-snowflake',100,f.signal)).rejects.toThrow('context_unavailable');
  });
  it('preserves pagination when a full page contains only excluded webhooks',async () => {
    const f = fixture(),path = `/channels/${channel}/messages?limit=100`;
    f.data[path] = Array.from({ length: 100 },(_,i) => ({ id: String(700000000000000000n-BigInt(i)),channel_id: channel,type: 0,author: { id: bot,bot: true },webhook_id: bot,content: 'ignored',timestamp: '2026-11-14T11:00:00Z' }));
    expect(await f.source.fetchPage(request,undefined,100,f.signal)).toEqual({ messages: [],before: '699999999999999901' });
  });
  it('fails closed on foreign channels, malformed role data, departed members and timed out senders',async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => Object.assign(f.data[`/channels/${channel}`]!,{ guild_id: channel }),
      (f: ReturnType<typeof fixture>) => { f.data[`/guilds/${guild}/roles`] = [{ id: guild,permissions: 'bad' }]; },
      (f: ReturnType<typeof fixture>) => { delete f.data[`/guilds/${guild}/members/${user}`]; },
      (f: ReturnType<typeof fixture>) => Object.assign(f.data[`/guilds/${guild}/members/${user}`]!,{ communication_disabled_until: '2099-01-01T00:00:00Z' }),
    ]) { const f = fixture(); mutate(f); expect(await f.source.canRead(request,f.signal)).toBe(false); }
  });
});
