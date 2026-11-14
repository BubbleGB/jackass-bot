export const SOURCE_REPO = 'BubbleGB/jackass-bot';
export const SOURCE_URL = 'https://github.com/BubbleGB/jackass-bot';
export function sourceCommit(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('source_commit_invalid');
  return value;
}
export async function requireReleaseChecks({ source,repo,ref,token,http = fetch }) {
  sourceCommit(source);
  if (repo !== SOURCE_REPO || ref !== 'refs/heads/main' || !token) throw new Error('release_context_invalid');
  async function get(path) {
    try {
      const r = await http(`https://api.github.com/repos/${SOURCE_REPO}/${path}`,{ redirect: 'error',signal: AbortSignal.timeout(15000),headers: { authorization: `Bearer ${token}`,accept: 'application/vnd.github+json','x-github-api-version': '2022-11-28' } });
      if (!r.ok) throw new Error(); return await r.json();
    } catch { throw new Error('release_api_unavailable'); }
  }
  async function list(path,key) {
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`),rows = data[key];
      if (!Array.isArray(rows)) throw new Error('release_api_unavailable'); result.push(...rows);
      if (rows.length < 100) return result;
    } throw new Error('release_api_unavailable');
  }
  const comparison = await get(`compare/${source}...main`);
  if (!['ahead','identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== source) throw new Error('source_not_on_main');
  const runs = await list(`actions/runs?head_sha=${source}&event=push&branch=main`,'workflow_runs'),verified = [];
  for (const [path,prefix] of [['checks.yml','foundation'],['image.yml','image']]) {
    const run = runs.filter(r => r.path === `.github/workflows/${path}` && r.head_sha === source && r.event === 'push' && r.head_branch === 'main').sort((a,b) => b.id-a.id)[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('required_checks_not_passed');
    const jobs = await list(`actions/runs/${run.id}/jobs?filter=latest`,'jobs');
    for (const runner of ['ubuntu-24.04','ubuntu-24.04-arm']) {
      const j = jobs.find(j => j.name === `${prefix} (${runner})`);
      if (!j || j.head_sha !== source || j.status !== 'completed' || j.conclusion !== 'success' || !j.labels?.includes(runner)) throw new Error('required_checks_not_passed');
    } verified.push(run.id);
  } return verified;
}
