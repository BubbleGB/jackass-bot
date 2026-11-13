import type { AccessLevel } from '../domain/types.js';
import type { MembershipRepository, MembershipSnapshot } from './discord-membership.js';
export type AccessAction = 'read' | 'settings' | 'lowerAllowance' | 'raiseAllowance' | 'credentials' | 'grants';
export interface AccessGrant { subjectType: 'user' | 'role'; subjectId: string }
export interface AccessRepository {
  isApproved(guildId: string): Promise<boolean>;
  grants(guildId: string): Promise<readonly AccessGrant[]>;
}
export class SettingsError extends Error {
  constructor(public readonly code: 'forbidden' | 'invalid_settings' | 'revision_conflict' | 'not_configured' | 'storage_failed' | 'credential_invalid') { super(code); this.name = 'SettingsError'; }
}
export const isSnowflake = (id: unknown): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id);
export function can(level: AccessLevel, action: AccessAction): boolean {
  return level === 'admin' || level === 'creator' || (level === 'delegate' && ['read', 'settings', 'lowerAllowance'].includes(action));
}
export class AccessPolicy {
  constructor(readonly creatorId: string, readonly membership: MembershipRepository, private readonly repository: AccessRepository) {
    if (!isSnowflake(creatorId)) throw new SettingsError('invalid_settings');
  }
  async member(userId: string, guildId: string): Promise<MembershipSnapshot | null> {
    if (![userId, guildId].every(isSnowflake)) return null;
    try {
      const m = await this.membership.lookup(userId, guildId);
      if (!m || m.guildId !== guildId || m.userId !== userId || !m.botPresent) return null;
      return m;
    } catch { return null; }
  }
  async resolveAccess(userId: string, guildId: string, repository = this.repository): Promise<AccessLevel> {
    try {
      if (![userId, guildId].every(isSnowflake) || !await repository.isApproved(guildId)) return 'none';
      const member = await this.member(userId, guildId);
      if (!member) return 'none';
      if (userId === this.creatorId) return 'creator';
      if (userId === member.ownerId) return 'admin';
      const current = new Set(member.roles.map(r => r.id));
      const assigned = new Set([guildId, ...member.roleIds.filter(id => current.has(id))]);
      if (member.roles.some(role => assigned.has(role.id) && (BigInt(role.permissions) & 8n) !== 0n)) return 'admin';
      const grants = await repository.grants(guildId);
      return grants.some(g => (g.subjectType === 'user' && g.subjectId === userId) || (g.subjectType === 'role' && assigned.has(g.subjectId) && current.has(g.subjectId))) ? 'delegate' : 'none';
    } catch { return 'none'; }
  }
  async require(actorId: string, guildId: string, action: AccessAction, repository = this.repository): Promise<AccessLevel> {
    const level = await this.resolveAccess(actorId, guildId, repository);
    if (!can(level, action)) throw new SettingsError('forbidden');
    return level;
  }
  requireCreator(actorId: string): void { if (actorId !== this.creatorId) throw new SettingsError('forbidden'); }
}
