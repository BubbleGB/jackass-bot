import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ghcr,verifyRelease,IMAGE } from '../../deploy/release/registry.mjs';
const source = 'a'.repeat(40),digest = b => 'sha256:'+createHash('sha256').update(b).digest('hex');
function fixture({ platforms = ['amd64','arm64'],revision = source,anonymous = 200,badDigest = false,duplicate = false,configArch,wrongSource = false } = {}) {
  const bodies = new Map();
  const manifests = platforms.map(architecture => {
    const config = JSON.stringify({ os: 'linux',architecture: configArch ?? architecture,config: { Labels: { 'org.opencontainers.image.revision': revision,'org.opencontainers.image.source': wrongSource ? 'https://github.com/other/repo' : 'https://github.com/BubbleGB/jackass-bot' } } });
    const cd = digest(config); bodies.set('/blobs/'+cd,config);
    const manifest = JSON.stringify({ schemaVersion: 2,mediaType: 'application/vnd.oci.image.manifest.v1+json',config: { digest: cd } }); const md = digest(manifest); bodies.set('/manifests/'+md,manifest);
    return { mediaType: 'application/vnd.oci.image.manifest.v1+json',digest: md,platform: { os: 'linux',architecture } };
  });
  if (duplicate) manifests.push(manifests[0]);
  const top = JSON.stringify({ schemaVersion: 2,mediaType: 'application/vnd.oci.image.index.v1+json',manifests }),expectedDigest = digest(top); bodies.set('/manifests/sha-'+source,top); bodies.set('/manifests/'+expectedDigest,top);
  const http = async (url,init = {}) => {
    const u = new URL(url); assert.equal(u.origin,'https://ghcr.io');
    if (u.pathname === '/token') return Response.json({ token: new Headers(init.headers).has('authorization') ? 'authenticated' : 'anonymous' });
    const auth = new Headers(init.headers).get('authorization');
    if (auth === 'Bearer anonymous' && anonymous !== 200) return new Response(null,{ status: anonymous });
    const body = bodies.get(u.pathname.replace('/v2/bubblegb/galaxy-neegy','')); if (!body) return new Response(null,{ status: 404 });
    return new Response(body,{ headers: { 'docker-content-digest': badDigest ? 'sha256:'+'0'.repeat(64) : digest(body) } });
  };
  return { registry: new Ghcr(http,'actor','synthetic-token'),expectedDigest,bodies };
}
test('verifies published index, ARM64/AMD64 configs, exact source and anonymous pull',async () => {
  const f = fixture(),report = await verifyRelease(f.registry,'sha-'+source,source);
  assert.deepEqual(report,{ image: IMAGE+'@'+f.expectedDigest,sourceCommit: source,platforms: ['linux/amd64','linux/arm64'],registryCredentialsRequired: false });
});
test('verification requests only pull scope, allowing a read-only token',async () => {
  const f = fixture(),http = f.registry.http;
  f.registry.http = (url,init) => { const u = new URL(url); if (u.pathname === '/token') assert.equal(u.searchParams.get('scope'),'repository:bubblegb/galaxy-neegy:pull'); return http(url,init); };
  await verifyRelease(f.registry,'sha-'+source,source);
});
test('reports registry credentials required only after an explicit anonymous denial',async () => {
  for (const anonymous of [401,403]) assert.equal((await verifyRelease(fixture({ anonymous }).registry,'sha-'+source,source)).registryCredentialsRequired,true);
});
for (const [name,options] of Object.entries({ missing_arm: { platforms: ['amd64'] },duplicate: { duplicate: true },wrong_revision: { revision: 'b'.repeat(40) },bad_digest: { badDigest: true },wrong_config_arch: { configArch: 'amd64' },wrong_source: { wrongSource: true } })) test(`rejects ${name} published metadata`,async () => {
  await assert.rejects(verifyRelease(fixture(options).registry,'sha-'+source,source));
});
test('does not label an anonymous outage/missing manifest as private',async () => {
  for (const anonymous of [404,429,500]) await assert.rejects(verifyRelease(fixture({ anonymous }).registry,'sha-'+source,source),/anonymous_pull_unverified/);
});
test('requires the published manifest to exist',async () => { const f = fixture(); f.bodies.clear(); await assert.rejects(verifyRelease(f.registry,'sha-'+source,source),/manifest_missing/); });
test('sanitises registry transport errors',async () => {
  const r = new Ghcr(async () => { throw new Error('synthetic-private-token'); },'actor','synthetic-token');
  await assert.rejects(verifyRelease(r,'sha-'+source,source),e => !String(e).includes('synthetic-private-token') && /registry_unavailable/.test(String(e)));
});
test('follows HTTPS config-blob redirects without forwarding registry credentials',async () => {
  const f = fixture(),http = f.registry.http; let redirected = 0;
  f.registry.http = (url,init) => {
    const u = new URL(url);
    if (u.hostname === 'ghcr.io' && u.pathname.includes('/blobs/')) return Promise.resolve(new Response(null,{ status: 307,headers: { location: 'https://pkg-containers.githubusercontent.com/config/'+u.pathname.split('/').at(-1)+'?signed=synthetic' } }));
    if (u.hostname === 'pkg-containers.githubusercontent.com') { redirected++; assert.equal(new Headers(init.headers).has('authorization'),false); return Promise.resolve(new Response(f.bodies.get('/blobs/'+u.pathname.split('/').at(-1)))); }
    return http(url,init);
  };
  assert.equal((await verifyRelease(f.registry,'sha-'+source,source)).registryCredentialsRequired,false); assert.equal(redirected,2);
});
test('retains config digest verification after a storage redirect',async () => {
  const f = fixture(),http = f.registry.http;
  f.registry.http = (url,init) => { const u = new URL(url); if (u.hostname === 'pkg-containers.githubusercontent.com') return Promise.resolve(new Response('{}')); if (u.pathname.includes('/blobs/')) return Promise.resolve(new Response(null,{ status: 307,headers: { location: 'https://pkg-containers.githubusercontent.com/config' } })); return http(url,init); };
  await assert.rejects(verifyRelease(f.registry,'sha-'+source,source),/registry_digest_mismatch/);
});
test('rejects insecure storage redirects and bounds redirect loops',async () => {
  for (const insecure of [true,false]) {
    const f = fixture(),http = f.registry.http; let requests = 0;
    f.registry.http = (url,init) => { if (new URL(url).pathname.includes('/blobs/')) { requests++; return Promise.resolve(new Response(null,{ status: 307,headers: { location: insecure ? 'http://storage.invalid/config' : url } })); } return http(url,init); };
    await assert.rejects(verifyRelease(f.registry,'sha-'+source,source),/registry_redirect_invalid/); assert.equal(requests,insecure ? 1 : 4);
  }
});
