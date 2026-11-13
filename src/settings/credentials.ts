import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProviderId } from '../domain/types.js';
import { SettingsError, isSnowflake } from '../access/policy.js';
export interface CredentialEnvelope { ciphertext: Buffer; nonce: Buffer; keyVersion: number }
/** Internal crypto primitive, not a dashboard service. Only the future provider
 * worker may open envelopes; SettingsService exposes set/remove/status only.
 */
export class CredentialCipher {
  #keys: Map<number, Buffer>;
  #activeVersion: number;
  constructor(activeVersion: number, keys: ReadonlyMap<number, Buffer>) {
    if (!Number.isSafeInteger(activeVersion) || activeVersion < 1 || !keys.has(activeVersion)
      || [...keys].some(([version, key]) => !Number.isSafeInteger(version) || version < 1 || key.length !== 32)) throw new SettingsError('credential_invalid');
    this.#activeVersion = activeVersion; this.#keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
  }
  private aad(guildId: string, provider: ProviderId, version: number): Buffer {
    if (!isSnowflake(guildId) || !['openai', 'google'].includes(provider)) throw new SettingsError('credential_invalid');
    return Buffer.from(JSON.stringify(['galaxy-neegy', 'provider-credential', guildId, provider, version]));
  }
  seal(guildId: string, provider: ProviderId, plaintext: string): CredentialEnvelope {
    if (typeof plaintext !== 'string' || !plaintext.trim() || plaintext.length > 4096) throw new SettingsError('credential_invalid');
    const keyVersion = this.#activeVersion, nonce = randomBytes(12), key = this.#keys.get(keyVersion)!;
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.aad(guildId, provider, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, keyVersion };
  }
  open(guildId: string, provider: ProviderId, envelope: CredentialEnvelope): string {
    try {
      const key = this.#keys.get(envelope.keyVersion);
      if (!key || envelope.nonce.length !== 12 || envelope.ciphertext.length <= 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
      decipher.setAAD(this.aad(guildId, provider, envelope.keyVersion));
      decipher.setAuthTag(envelope.ciphertext.subarray(-16));
      return Buffer.concat([decipher.update(envelope.ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
    } catch { throw new SettingsError('credential_invalid'); }
  }
}
/** A web-facing credential capability intentionally has no plaintext read method. */
export interface CredentialService {
  setCredential(actorId: string, guildId: string, provider: ProviderId, key: string): Promise<void>;
  removeCredential(actorId: string, guildId: string, provider: ProviderId): Promise<void>;
  credentialStatus(actorId: string, guildId: string, provider: ProviderId): Promise<{ configured: boolean }>;
}
