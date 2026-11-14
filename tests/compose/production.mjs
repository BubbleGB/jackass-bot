// Render only: never creates containers/networks, pulls images or reads secret contents.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../../',import.meta.url));
const env = { ...process.env,
  GALAXY_IMAGE: `example.invalid/galaxy-neegy@sha256:${'a'.repeat(64)}`,
  GALAXY_SECRETS_DIR: '/tmp/galaxy-compose-dummy-secrets',
  // A nonzero inherited host mapping must disappear; wrong base origin must be replaced.
  GALAXY_HTTP_PORT: '49123',PUBLIC_ORIGIN: 'https://placeholder.invalid',
  DISCORD_CLIENT_ID: '444444444444444444',CREATOR_USER_ID: '333333333333333333',
  CONTACT_URL: '',ENCRYPTION_KEY_VERSION: '1',COMPOSE_DISABLE_ENV_FILE: 'true',
};
const rendered = JSON.parse(execFileSync('docker',['compose','--env-file','/dev/null',
  '--project-name','galaxy-neegy','-f','compose.yaml','-f','compose.production.yaml',
  '--profile','ops','config','--format','json'],{ cwd,env,encoding: 'utf8' }));
assert.equal(rendered.name,'galaxy-neegy');
assert.deepEqual(Object.keys(rendered.services).sort(),['app','migrate','postgres']);
for (const [name,s] of Object.entries(rendered.services)) {
  assert.deepEqual(s.ports ?? [],[],`${name} publishes a host port after merging`);
  assert.notEqual(s.network_mode,'host',`${name} bypasses network isolation`);
  assert.deepEqual(Object.keys(s.networks).sort(),name === 'app' ? ['aio_network','backend'] : ['backend'],`${name} joins an unexpected network`);
  assert.equal(s.labels['com.centurylinklabs.watchtower.enable'],'false');
  assert.equal(s.labels['traefik.enable'],name === 'app' ? 'true' : 'false');
}
assert.equal(rendered.networks.backend.internal,true);
assert.equal(rendered.networks.backend.name,'galaxy-neegy_backend');
assert.equal(rendered.networks.aio_network.external,true);
assert.equal(rendered.networks.aio_network.name,'aio_network');
const app = rendered.services.app;
assert.equal(app.environment.PORT,'3000');
assert.equal(app.environment.PUBLIC_ORIGIN,'https://galaxy.bubbleaio.uk');
const expected = {
  'traefik.docker.network': 'aio_network',
  'traefik.http.routers.galaxy-neegy.rule': 'Host(`galaxy.bubbleaio.uk`)',
  'traefik.http.routers.galaxy-neegy.entrypoints': 'websecure',
  'traefik.http.routers.galaxy-neegy.tls': 'true',
  'traefik.http.routers.galaxy-neegy.tls.certresolver': 'letsencrypt',
  'traefik.http.routers.galaxy-neegy.service': 'galaxy-neegy',
  'traefik.http.services.galaxy-neegy.loadbalancer.server.port': app.environment.PORT,
};
for (const [key,value] of Object.entries(expected)) assert.equal(app.labels[key],value,key);
// Safe report: do not print the rendered environment, secret paths or full config.
console.log(JSON.stringify({ project: rendered.name,services: Object.fromEntries(
  Object.entries(rendered.services).map(([name,s]) => [name,{
    networks: Object.keys(s.networks).map(n => rendered.networks[n].name),
    publishedPorts: s.ports ?? [],labels: s.labels,
  }]),
) },null,2));
