/** Test-only guard; never fall back to the application's DATABASE_URL.
 * Reject query options: node-postgres permits them to override the parsed host.
 */
export function localTestDatabaseUrl(rawUrl: string | undefined): URL {
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required; use an isolated local PostgreSQL test database');
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    throw new Error('TEST_DATABASE_URL must be a valid local PostgreSQL test URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname)
    || !/test/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('TEST_DATABASE_URL must name a local test database without query options or fragments');
  }
  return url;
}
