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
