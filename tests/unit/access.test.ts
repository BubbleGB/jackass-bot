import { describe, expect, it } from 'vitest';
import { AccessPolicy, can } from '../../src/access/policy.js';
import type { MembershipSnapshot, MembershipRepository } from '../../src/access/discord-membership.js';

const guild = '111111111111111111', owner = '222222222222222222', creator = '333333333333333333', user = '444444444444444444', role = '555555555555555555';
const snapshot = (patch: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({ guildId: guild, userId: user, ownerId: owner, botPresent: true, roleIds: [], roles: [{ id: guild, permissions: '0' }, { id: role, permissions: '0' }], ...patch });
function fixture(member: MembershipSnapshot | null = snapshot(), approved = true, grants: { subjectType: 'user' | 'role'; subjectId: string }[] = []) {
  const membership: MembershipRepository = { async lookup() { return member; }, async isTextChannel() { return true; } };
  const policy = new AccessPolicy(creator, membership, { async isApproved() { return approved; }, async grants() { return grants; } });
  return { policy, membership };
}
describe('current guild access policy', () => {
  it.each([
    ['owner', snapshot({ userId: owner }), true, [], owner, 'admin'],
    ['administrator', snapshot({ roleIds: [role], roles: [{ id: role, permissions: '8' }] }), true, [], user, 'admin'],
    ['manage-server only', snapshot({ roleIds: [role], roles: [{ id: role, permissions: '32' }] }), true, [], user, 'none'],
    ['creator member', snapshot({ userId: creator }), true, [], creator, 'creator'],
    ['departed creator', null, true, [], creator, 'none'],
    ['bot absent', snapshot({ userId: creator, botPresent: false }), true, [], creator, 'none'],
    ['ordinary member', snapshot(), true, [], user, 'none'],
    ['user delegate', snapshot(), true, [{ subjectType: 'user', subjectId: user }], user, 'delegate'],
    ['role delegate', snapshot({ roleIds: [role] }), true, [{ subjectType: 'role', subjectId: role }], user, 'delegate'],
    ['everyone role delegate', snapshot(), true, [{ subjectType: 'role', subjectId: guild }], user, 'delegate'],
    ['deleted role', snapshot({ roleIds: [role], roles: [{ id: guild, permissions: '0' }] }), true, [{ subjectType: 'role', subjectId: role }], user, 'none'],
    ['unapproved owner', snapshot({ userId: owner }), false, [], owner, 'none'],
    ['spoofed guild', snapshot({ guildId: '999999999999999999' }), true, [], user, 'none'],
    ['spoofed member', snapshot({ userId: owner }), true, [], user, 'none'],
  ] as const)('%s', async (_name, member, approved, grants, actor, expected) => {
    const { policy } = fixture(member, approved, [...grants]);
    expect(await policy.resolveAccess(actor, guild)).toBe(expected);
  });
  it('fails closed on Discord lookup errors', async () => {
    const { policy, membership } = fixture(); membership.lookup = async () => { throw new Error('private response'); };
    expect(await policy.resolveAccess(user, guild)).toBe('none');
  });
  it('checks current membership on each operation, losing a revoked role immediately', async () => {
    const { policy, membership } = fixture(snapshot({ roleIds: [role] }), true, [{ subjectType: 'role', subjectId: role }]);
    expect(await policy.resolveAccess(user, guild)).toBe('delegate');
    membership.lookup = async () => snapshot();
    expect(await policy.resolveAccess(user, guild)).toBe('none');
  });
  it('restricts sensitive actions and cannot delegate approval', () => {
    for (const action of ['read', 'settings', 'lowerAllowance'] as const) expect(can('delegate', action)).toBe(true);
    for (const action of ['credentials', 'grants', 'raiseAllowance'] as const) {
      expect(can('delegate', action)).toBe(false); expect(can('admin', action)).toBe(true);
    }
    expect(can('none', 'read')).toBe(false);
  });
});
