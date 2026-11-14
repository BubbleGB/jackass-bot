import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { imageIdentity,archiveHash,checkArchive } from '../../deploy/release/images.mjs';
const source = 'a'.repeat(40),imageId = 'sha256:'+'b'.repeat(64);
const inspected = () => ({ Id: imageId,Os: 'linux',Architecture: 'arm64',Config: { Labels: { 'org.opencontainers.image.revision': source,'org.opencontainers.image.source': 'https://github.com/BubbleGB/jackass-bot' } } });
test('binds the tested image identity to platform and immutable source',() => { assert.equal(imageIdentity(inspected(),source,'arm64'),imageId); });
for (const field of ['platform','source','repository','id']) test(`rejects an image with wrong ${field} before publication`,() => {
  const image = inspected(); if (field === 'platform') image.Architecture = 'amd64'; if (field === 'source') image.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40); if (field === 'repository') image.Config.Labels['org.opencontainers.image.source'] = 'other'; if (field === 'id') image.Id = 'missing';
  assert.throws(() => imageIdentity(image,source,'arm64'),/image_identity_invalid/);
});
test('rejects a modified archive, proof source or platform instead of loading/publishing it',async () => {
  const dir = await mkdtemp(tmpdir()+'/galaxy-release-proof-'),file = dir+'/image.tar.gz';
  try {
    await writeFile(file,'Synthetic archive bytes');
    const proof = { source,architecture: 'arm64',imageId,archiveSha256: await archiveHash(file) };
    await checkArchive(proof,file,source,'arm64');
    for (const change of [{ source: 'c'.repeat(40) },{ architecture: 'amd64' },{ imageId: 'invalid' }]) await assert.rejects(checkArchive({ ...proof,...change },file,source,'arm64'),/archive_proof_invalid/);
    await writeFile(file,'Changed archive bytes'); await assert.rejects(checkArchive(proof,file,source,'arm64'),/archive_proof_invalid/);
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
