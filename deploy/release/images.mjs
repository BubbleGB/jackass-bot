import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { sourceCommit,SOURCE_URL } from './gate.mjs';
export function imageIdentity(image,source,architecture) {
  sourceCommit(source);
  if (!['amd64','arm64'].includes(architecture) || image.Os !== 'linux' || image.Architecture !== architecture || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Config?.Labels?.['org.opencontainers.image.revision'] !== source || image.Config.Labels['org.opencontainers.image.source'] !== SOURCE_URL) throw new Error('image_identity_invalid');
  return image.Id;
}
export async function archiveHash(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function checkArchive(proof,file,source,architecture) {
  sourceCommit(source);
  if (proof.source !== source || proof.architecture !== architecture || !/^sha256:[a-f0-9]{64}$/.test(proof.imageId) || !/^[a-f0-9]{64}$/.test(proof.archiveSha256) || await archiveHash(file) !== proof.archiveSha256) throw new Error('archive_proof_invalid');
}
export async function loadTestedArchive({ proof,file },source,architecture,run) {
  await checkArchive(proof,file,source,architecture);
  run(['load','--input',file]); const image = JSON.parse(run(['image','inspect','galaxy-release:'+architecture]))[0];
  if (imageIdentity(image,source,architecture) !== proof.imageId) throw new Error('loaded_image_mismatch');
}
