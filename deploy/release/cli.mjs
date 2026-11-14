import { execFileSync } from 'node:child_process';
import { readFile,writeFile,appendFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { sourceCommit,requireReleaseChecks } from './gate.mjs';
import { imageIdentity,archiveHash,loadTestedArchive } from './images.mjs';
import { Ghcr,verifyRelease } from './registry.mjs';
import { publishTested } from './publish.mjs';
const env = process.env,mode = process.argv[2]; let source;
function docker(args,input) {
  try { return execFileSync('docker',args,{ encoding: 'utf8',input,maxBuffer: 16*1024*1024,timeout: 300000,stdio: ['pipe','pipe','pipe'] }); }
  catch { throw new Error('release_docker_command_failed'); }
}
async function checks() {
  const options = { source,repo: env.GITHUB_REPOSITORY,ref: env.GITHUB_REF,token: env.GH_TOKEN };
  const runs = await requireReleaseChecks(options);
  const control = sourceCommit(env.CONTROL_COMMIT);
  if (control !== source) await requireReleaseChecks({ ...options,source: control });
  return runs;
}
async function main() {
  source = sourceCommit(env.SOURCE_COMMIT);
  if (mode === 'gate') {
    const runs = await checks(); await appendFile(env.GITHUB_OUTPUT,`source=${source}\n`);
    await appendFile(env.GITHUB_STEP_SUMMARY,`Release source: ${source}\n\nVerified source CI runs: ${runs.join(', ')}\n`); return;
  }
  if (mode === 'record') {
    const architecture = env.ARCHITECTURE,image = JSON.parse(docker(['image','inspect','galaxy-release:'+architecture]))[0];
    const proof = { source,architecture,imageId: imageIdentity(image,source,architecture),archiveSha256: await archiveHash(env.ARCHIVE_FILE) };
    await writeFile(join(dirname(env.ARCHIVE_FILE),'proof.json'),JSON.stringify(proof)); return;
  }
  if (mode === 'roundtrip') {
    const proof = JSON.parse(await readFile(join(dirname(env.ARCHIVE_FILE),'proof.json'),'utf8'));
    await loadTestedArchive({ proof,file: env.ARCHIVE_FILE },source,env.ARCHITECTURE,docker); return;
  }
  const registry = new Ghcr(fetch,env.GITHUB_ACTOR,env.GH_TOKEN);
  if (mode === 'publish') {
    await checks(); docker(['buildx','version']); const archives = {};
    for (const architecture of ['amd64','arm64']) { const dir = join(env.ARCHIVES_DIR,'release-image-'+architecture); archives[architecture] = { file: join(dir,'image.tar.gz'),proof: JSON.parse(await readFile(join(dir,'proof.json'),'utf8')) }; }
    docker(['login','ghcr.io','--username',env.GITHUB_ACTOR,'--password-stdin'],env.GH_TOKEN);
    await publishTested({ source,runId: env.GITHUB_RUN_ID,attempt: env.GITHUB_RUN_ATTEMPT,archives,registry,run: docker }); return;
  }
  if (mode === 'verify') {
    await checks(); const report = await verifyRelease(registry,'sha-'+source,source);
    await writeFile('release-report.json',JSON.stringify(report,null,2)+'\n');
    await appendFile(env.GITHUB_STEP_SUMMARY,`Verified registry reference: ${report.image}\n\nSource: ${source}\n\nPlatforms: ${report.platforms.join(', ')}\n\nVPS registry credentials required: ${report.registryCredentialsRequired}\n`);
    console.log(JSON.stringify(report)); return;
  }
  throw new Error('release_mode_invalid');
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'release_failed'); process.exitCode = 1; });
