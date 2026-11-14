import { sourceCommit } from './gate.mjs';
import { loadTestedArchive } from './images.mjs';
import { IMAGE } from './registry.mjs';
export async function publishTested({ source,runId,attempt,archives,registry,run }) {
  sourceCommit(source);
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt)) throw new Error('release_run_invalid');
  const tag = 'sha-'+source;
  if (await registry.manifest(tag)) throw new Error('release_tag_exists');
  // Validate and load BOTH tested images before any registry push. Never rebuild here.
  for (const architecture of ['amd64','arm64']) {
    await loadTestedArchive(archives[architecture],source,architecture,run);
  }
  const digests = [];
  for (const architecture of ['amd64','arm64']) {
    const part = `build-${runId}-${attempt}-${architecture}`,target = IMAGE+':'+part;
    if (await registry.manifest(part)) throw new Error('release_tag_exists');
    run(['tag','galaxy-release:'+architecture,target]); run(['push',target]);
    const pushed = await registry.manifest(part);
    if (pushed?.body.config?.digest !== archives[architecture].proof.imageId) throw new Error('pushed_image_mismatch');
    digests.push(IMAGE+'@'+pushed.digest);
  }
  // Serialize workflows and refuse an existing commit tag; registry admins can still
  // change tags outside this workflow. Deployment always uses the verified digest.
  if (await registry.manifest(tag)) throw new Error('release_tag_exists');
  run(['buildx','imagetools','create','--tag',IMAGE+':'+tag,...digests]); return tag;
}
