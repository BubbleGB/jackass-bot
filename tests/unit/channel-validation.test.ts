import { describe, expect, it, vi } from 'vitest';
import { validateNewChannels } from '../../src/settings/validation.js';

describe('bounded channel configuration checks', () => {
  it('has one total deadline and at most four outstanding lookups', async () => {
    vi.useFakeTimers(); let calls = 0;
    try {
      const result = validateNewChannels('111111111111111111',['1','2','3','4','5','6'],{
        async lookup() { return null; },
        async isTextChannel() { calls++; return new Promise<boolean>(() => undefined); },
      }).then(() => 'accepted',error => String(error));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe('SettingsError: invalid_settings');
      expect(calls).toBe(4);
    } finally { vi.useRealTimers(); }
  });
  it('cancels outstanding transports when any channel is invalid', async () => {
    const signals: AbortSignal[] = [];
    await expect(validateNewChannels('111111111111111111',['1','2'],{
      async lookup() { return null; },
      async isTextChannel(_guild,id,signal) { if (signal) signals.push(signal); return id !== '1'; },
    })).rejects.toThrow('invalid_settings');
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});
