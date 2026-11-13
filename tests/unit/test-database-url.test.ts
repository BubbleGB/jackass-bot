import { describe, expect, it } from 'vitest';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';

describe('isolated test database guard', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'postgres'])('permits the local test host %s', (host) => {
    expect(localTestDatabaseUrl(`postgresql://test_user:public_test_password@${host}:5432/galaxy_test`).hostname).toBe(host);
  });
  it.each([
    undefined,
    'postgresql://remote.example/galaxy_test',
    'postgresql://localhost/production',
    'postgresql://localhost/galaxy_test?host=remote.example',
    'postgresql://localhost/galaxy_test?hostaddr=192.0.2.1',
    'postgresql://localhost/galaxy_test?port=5433',
    'postgresql://localhost/galaxy_test#unexpected',
    'https://localhost/galaxy_test',
    'not-a-url-private-value',
  ])('rejects unsafe or ambiguous test connections %# without echoing the URL', (rawUrl) => {
    let error: unknown;
    try { localTestDatabaseUrl(rawUrl); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    if (rawUrl) expect(String(error)).not.toContain(rawUrl);
  });
});
