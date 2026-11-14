import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceCommit,requireReleaseChecks } from '../../deploy/release/gate.mjs';
const source = 'a'.repeat(40),repo = 'BubbleGB/jackass-bot';
const workflows = ['checks.yml','image.yml'];
function fixture(change = () => undefined) {
  const runs = workflows.map((p,i) => ({ id: i+1,path: `.github/workflows/${p}`,event: 'push',head_branch: 'main',head_sha: source,status: 'completed',conclusion: 'success' }));
  const jobs = workflows.map((p,i) => ['ubuntu-24.04','ubuntu-24.04-arm'].map(r => ({ name: `${i ? 'image' : 'foundation'} (${r})`,head_sha: source,status: 'completed',conclusion: 'success',labels: [r] })));
  change({ runs,jobs });
  return async url => {
    const u = new URL(url); assert.equal(u.origin,'https://api.github.com');
    if (u.pathname.includes('/compare/')) return Response.json({ merge_base_commit: { sha: source },status: 'ahead' });
    if (u.pathname.endsWith('/actions/runs')) return Response.json({ workflow_runs: runs });
    const match = u.pathname.match(/\/runs\/(\d+)\/jobs$/); if (match) return Response.json({ jobs: jobs[Number(match[1])-1] });
    throw new Error('unexpected_fixture_route');
  };
}
const options = () => ({ source,repo,ref: 'refs/heads/main',token: 'synthetic',http: fixture() });
test('requires a full lowercase SHA, not branch/tag/shell syntax',() => {
  for (const value of ['main','v1','a'.repeat(7),'A'.repeat(40),source+'\n','$(echo bad)',null]) assert.throws(() => sourceCommit(value),/source_commit_invalid/);
  assert.equal(sourceCommit(source),source);
});
test('requires successful exact-source push runs and both native runners',async () => {
  const result = await requireReleaseChecks(options()); assert.deepEqual(result,[1,2]);
});
test('rejects non-main dispatch or another repository before making requests',async () => {
  for (const override of [{ ref: 'refs/heads/feature' },{ repo: 'other/repo' }]) await assert.rejects(requireReleaseChecks({ ...options(),...override,http: () => { throw new Error('must_not_request'); } }),/release_context_invalid/);
});
test('requires source to remain on main ancestry',async () => {
  await assert.rejects(requireReleaseChecks({ ...options(),http: async () => Response.json({ merge_base_commit: { sha: 'b'.repeat(40) },status: 'diverged' }) }),/source_not_on_main/);
});
for (const state of ['queued','failure','wrong_sha','wrong_branch','pull_request','missing_arm','emulated_arm','failed_arm','latest_failed']) test(`rejects ${state} CI instead of accepting other evidence`,async () => {
  const http = fixture(({ runs,jobs }) => {
    if (state === 'queued') runs[1].status = 'in_progress';
    if (state === 'failure') runs[1].conclusion = 'failure';
    if (state === 'wrong_sha') runs[1].head_sha = 'b'.repeat(40);
    if (state === 'wrong_branch') runs[1].head_branch = 'feature';
    if (state === 'pull_request') runs[1].event = 'pull_request';
    if (state === 'missing_arm') jobs[1].pop();
    if (state === 'emulated_arm') jobs[1][1].labels = ['ubuntu-24.04'];
    if (state === 'failed_arm') jobs[1][1].conclusion = 'failure';
    if (state === 'latest_failed') runs.push({ ...runs[1],id: 99,conclusion: 'failure' });
  }); await assert.rejects(requireReleaseChecks({ ...options(),http }),/required_checks_not_passed/);
});
test('does not expose API credentials or raw upstream errors',async () => {
  await assert.rejects(requireReleaseChecks({ ...options(),http: async () => { throw new Error('synthetic-private-token'); } }),e => !String(e).includes('synthetic-private-token') && /release_api_unavailable/.test(String(e)));
});
