import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { archiveHash } from '../../deploy/release/images.mjs';
import { publishTested } from '../../deploy/release/publish.mjs';
const source = 'a'.repeat(40),id = architecture => 'sha256:'+(architecture === 'amd64' ? 'b' : 'c').repeat(64);
async function setup(run) {
  const dir = await mkdtemp(tmpdir()+'/galaxy-publish-test-');
  try {
    const commands = [],archives = {};
    for (const architecture of ['amd64','arm64']) { const file = dir+'/'+architecture; await writeFile(file,architecture); archives[architecture] = { file,proof: { source,architecture,imageId: id(architecture),archiveSha256: await archiveHash(file) } }; }
    const options = { source,runId: '123',attempt: '1',archives,
      registry: { async manifest(ref) { return !commands.some(c => c[0] === 'push' && c[1].endsWith(':'+ref)) ? null : { digest: 'sha256:'+(ref.endsWith('amd64') ? 'd' : 'e').repeat(64),body: { config: { digest: id(ref.endsWith('amd64') ? 'amd64' : 'arm64') } } }; } },
      run(args) { commands.push(args); if (args[0] === 'image') { const architecture = args[2].split(':').at(-1); return JSON.stringify([{ Id: id(architecture),Os: 'linux',Architecture: architecture,Config: { Labels: { 'org.opencontainers.image.revision': source,'org.opencontainers.image.source': 'https://github.com/BubbleGB/jackass-bot' } } }]); } return ''; },
    }; await run(options,commands);
  } finally { await rm(dir,{ recursive: true,force: true }); }
}
test('publishes only the archived tested identities and creates the index from digests',async () => setup(async (o,commands) => {
  const result = await publishTested(o); assert.equal(result,'sha-'+source);
  assert.equal(commands.filter(c => c[0] === 'build').length,0); assert.equal(commands.filter(c => c[0] === 'push').length,2);
  const index = commands.find(c => c[0] === 'buildx'); assert(index); assert.equal(index.filter(v => v.startsWith('ghcr.io/bubblegb/galaxy-neegy@sha256:')).length,2);
}));
test('never overwrites an existing commit tag',async () => setup(async (o,commands) => {
  o.registry.manifest = async () => ({}); await assert.rejects(publishTested(o),/release_tag_exists/); assert.equal(commands.length,0);
}));
test('validates both archive proofs before any registry push',async () => setup(async (o,commands) => {
  o.archives.arm64.proof.imageId = 'invalid'; await assert.rejects(publishTested(o),/archive_proof_invalid/); assert.equal(commands.filter(c => c[0] === 'push').length,0);
}));
test('detects a changed loaded image before pushing either platform',async () => setup(async (o,commands) => {
  o.archives.arm64.proof.imageId = 'sha256:'+'f'.repeat(64); await assert.rejects(publishTested(o),/loaded_image_mismatch/); assert.equal(commands.filter(c => c[0] === 'push').length,0);
}));
test('does not create a release manifest if registry config differs from tested image',async () => setup(async (o,commands) => {
  const manifest = o.registry.manifest; o.registry.manifest = async ref => { const r = await manifest(ref); if (r) r.body.config.digest = 'sha256:'+'f'.repeat(64); return r; };
  await assert.rejects(publishTested(o),/pushed_image_mismatch/); assert.equal(commands.filter(c => c[0] === 'buildx').length,0);
}));
