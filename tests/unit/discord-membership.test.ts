import { describe, expect, it, vi } from 'vitest';
import { DiscordMembership, type DiscordGet } from '../../src/access/discord-membership.js';
import { DiscordRest } from '../../src/discord/transport.js';
const guild = '111111111111111111', user = '222222222222222222', bot = '333333333333333333', role = '444444444444444444', channel = '555555555555555555';
const responses: Record<string, unknown> = {
  [`/guilds/${guild}`]: { id: guild, owner_id: user },
  [`/guilds/${guild}/members/${user}`]: { user: { id: user }, roles: [role] },
  [`/guilds/${guild}/members/${bot}`]: { user: { id: bot }, roles: [] },
  [`/guilds/${guild}/roles`]: [{ id: guild, permissions: '0' }, { id: role, permissions: '8' }],
  [`/channels/${channel}`]: { id: channel, guild_id: guild, type: 0 },
};
describe('fresh documented Discord REST membership', () => {
  it('isolates pending lookups by both actor and guild',async () => {
    let release!: () => void,reads = 0; const gate = new Promise<void>(r => { release = r; });
    const adapter = new DiscordMembership(async path => {
      reads++; await gate; const parts = path.split('/');
      if (parts.length === 3) return { id: parts[2],owner_id: user };
      if (parts[3] === 'members') return { user: { id: parts[4] },roles: [] };
      return [];
    },bot);
    const work = [adapter.lookup(user,guild),adapter.lookup(role,guild),adapter.lookup(user,role)]; release();
    expect((await Promise.all(work)).map(x => [x?.userId,x?.guildId])).toEqual([[user,guild],[role,guild],[user,role]]); expect(reads).toBe(12);
  });
  it('times out a queued lookup, cancels its work and verifies afresh after the bucket recovers',async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const rest = new DiscordRest('synthetic',async url => {
        reads++; const path = new URL(String(url)).pathname.replace('/api/v10','');
        return new Response(JSON.stringify(responses[path]),{ headers: path.endsWith('/roles') ? { 'x-ratelimit-remaining': '0','x-ratelimit-reset-after': '6' } : {} });
      });
      const adapter = new DiscordMembership((path,signal) => rest.call({ method: 'GET',path,signal }),bot);
      expect(await adapter.lookup(user,guild)).not.toBeNull();
      const work = adapter.lookup(user,guild),assertion = expect(work).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(5000); await assertion; expect(reads).toBe(7);
      await vi.advanceTimersByTimeAsync(1100); expect(reads).toBe(7);
      expect(await adapter.lookup(user,guild)).not.toBeNull(); expect(reads).toBe(11);
    } finally { vi.useRealTimers(); }
  });
  it('shares only identical in-flight membership, then verifies departure afresh',async () => {
    let release!: () => void,reads = 0,departed = false;
    const gate = new Promise<void>(r => { release = r; });
    const adapter = new DiscordMembership(async path => { reads++; await gate; if (departed && path.endsWith(user)) return { user: { id: bot },roles: [] }; return responses[path]; },bot);
    const pending = [adapter.lookup(user,guild),adapter.lookup(user,guild),adapter.lookup(user,guild)]; release();
    expect((await Promise.all(pending)).every(Boolean)).toBe(true); expect(reads).toBe(4);
    departed = true; expect(await adapter.lookup(user,guild)).toBeNull(); expect(reads).toBe(8);
  });
  it.each(['guild','actor','bot'].flatMap(part => [undefined,null,'bad-id'].map(id => ({ part,id }))))('rejects malformed $part identity $id as unavailable, never as membership denial',async ({ part,id }) => {
    const adapter = new DiscordMembership(async path => {
      if (part === 'guild' && path === `/guilds/${guild}`) return { id,owner_id: user };
      if (part === 'actor' && path.endsWith(`/members/${user}`)) return { user: { id },roles: [] };
      if (part === 'bot' && path.endsWith(`/members/${bot}`)) return { user: { id },roles: [] };
      return responses[path];
    },bot);
    await expect(adapter.lookup(user,guild)).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('combines guild ownership, current member roles and bot membership', async () => {
    const adapter = new DiscordMembership(async path => responses[path], bot);
    expect(await adapter.lookup(user,guild)).toMatchObject({ guildId: guild, userId: user, ownerId: user, botPresent: true, roleIds: [role], roles: [{ id: guild, permissions: '0' }, { id: role, permissions: '8' }] });
    expect(await adapter.isTextChannel(guild,channel)).toBe(true);
  });
  it.each(['missing', 'forbidden', 'bad-member', 'bad-roles'])('fails closed on %s', async mode => {
    const adapter = new DiscordMembership(async path => {
      if (mode === 'forbidden') throw new Error('private Discord body');
      if (mode === 'missing' && path.endsWith(bot)) return undefined;
      if (mode === 'bad-member' && path.endsWith(user)) return { user: { id: bot }, roles: [] };
      if (mode === 'bad-roles' && path.endsWith('/roles')) return [{ id: role, permissions: 'bad' }];
      return responses[path];
    },bot);
    if (mode === 'bad-member') expect(await adapter.lookup(user,guild)).toBeNull();
    else await expect(adapter.lookup(user,guild)).rejects.toMatchObject({ reason: mode === 'forbidden' ? 'unavailable' : 'invalid_response' });
  });
  it.each([1, 2, 5, 10, 11, 12, 15])('rejects non-text channel type %s', async type => {
    const adapter = new DiscordMembership(async () => ({ id: channel, guild_id: guild, type }),bot);
    expect(await adapter.isTextChannel(guild,channel)).toBe(false);
  });
  it('rejects another guild channel', async () => {
    const adapter = new DiscordMembership(async () => ({ id: channel, guild_id: user, type: 0 }),bot);
    expect(await adapter.isTextChannel(guild,channel)).toBe(false);
  });
  it('bounds hung lookups even if the injected transport ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const hung: DiscordGet = async () => new Promise(() => undefined);
      const result = new DiscordMembership(hung,bot).lookup(user,guild);
      await Promise.all([expect(result).rejects.toMatchObject({ reason: 'timeout' }),vi.advanceTimersByTimeAsync(5000)]);
    } finally { vi.useRealTimers(); }
  });
  it.each([403,404])('keeps explicit HTTP %s membership denial closed',async status => {
    const rest = new DiscordRest('synthetic',async () => new Response('{}',{ status }));
    expect(await new DiscordMembership((path,signal) => rest.call({ method: 'GET',path,signal }),bot).lookup(user,guild)).toBeNull();
  });
  it.each([429,502])('distinguishes temporary HTTP %s from an absent member',async status => {
    const rest = new DiscordRest('synthetic',async () => new Response('{"retry_after":1}',{ status }));
    await expect(new DiscordMembership((path,signal) => rest.call({ method: 'GET',path,signal }),bot).lookup(user,guild)).rejects.toMatchObject({ reason: status === 429 ? 'rate_limited' : 'unavailable' });
  });
});
