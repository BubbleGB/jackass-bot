import { test,expect,type Page } from '@playwright/test';
const guild = '222222222222222222',initial = ['settings','channels','status','errors'];
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
async function signIn(page: Page) { await page.goto(`/auth/discord?returnTo=/servers/${guild}`); await page.getByRole('button',{ name: 'Continue as owner' }).click(); }
async function traceLoad(page: Page,beforeFirstGrants?: () => Promise<void>) {
  const starts: string[] = [],responses: { route: string; status: number }[] = []; let release!: () => void;
  let grantsPrepared = false;
  const gate = new Promise<void>(r => { release = r; });
  page.on('response',r => { const route = new URL(r.url()).pathname.split('/').at(-1)!; if (r.url().includes(`/api/guilds/${guild}/`)) responses.push({ route,status: r.status() }); });
  await page.route(`**/api/guilds/${guild}/*`,async route => {
    const p = new URL(route.request().url()).pathname.split('/').at(-1)!;
    starts.push(p); if (initial.includes(p) && starts.filter(p => initial.includes(p)).length === 4) release();
    if (initial.includes(p)) await gate;
    if (p === 'grants') expect(responses.some(r => r.route === 'settings' && r.status === 200)).toBe(true);
    if (p === 'grants' && beforeFirstGrants && !grantsPrepared) {
      // Target the later operation, not the scheduler-dependent second REST lookup.
      await expect.poll(() => responses.filter(r => initial.includes(r.route)).length).toBe(4);
      grantsPrepared = true; await beforeFirstGrants();
    }
    await route.continue();
  }); return { starts,responses };
}
test('offers retry instead of an access-denied warning when initial concurrent verification is unavailable',async ({ page,request }) => {
  await request.post('/mock/access-fault',{ data: { mode: 'unavailable' } }); const trace = await traceLoad(page); await signIn(page);
  await expect(page.getByRole('alert')).toContainText('verification is temporarily unavailable');
  await expect.poll(() => trace.responses.length).toBe(4); expect(trace.starts.sort()).toEqual([...initial].sort()); expect(trace.responses.some(r => r.status === 503)).toBe(true);
  await expect(page.getByLabel('Shared personality')).toHaveCount(0);
  for (const p of [...initial,'grants']) expect((await page.request.get(`/api/guilds/${guild}/${p}`)).status()).toBe(200);
  await request.post('/mock/access-fault',{ data: { mode: 'none' } }); await page.getByRole('button',{ name: 'Retry loading settings' }).click();
  await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
});
test('scopes a later grants verification failure and retries without losing unsaved settings',async ({ page,request }) => {
  const trace = await traceLoad(page,async () => { await request.post('/mock/access-fault',{ data: { mode: 'unavailable' } }); }); await signIn(page);
  await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect(page.locator('#access').getByRole('alert')).toContainText('verification is temporarily unavailable');
  expect(trace.starts.slice(0,4).sort()).toEqual([...initial].sort()); expect(trace.starts[4]).toBe('grants'); expect(trace.responses.find(r => r.route === 'grants')?.status).toBe(503);
  // Arming the fault resets the counter after the initial reads: this is grants only.
  expect(await (await page.request.get('/mock/access-trace')).json()).toEqual({ lookups: 1,discordReads: 4 });
  await page.getByLabel('Shared personality').fill('Preserve this draft during access retry');
  await page.getByRole('button',{ name: 'Retry loading grants' }).click(); await expect(page.locator('#access').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Shared personality')).toHaveValue('Preserve this draft during access retry');
});
test('slow successful lookups complete the actual concurrent load without an access warning',async ({ page,request }) => {
  await request.post('/mock/access-fault',{ data: { mode: 'slow' } }); const trace = await traceLoad(page); await signIn(page);
  await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect.poll(() => trace.responses.length).toBe(5);
  expect(trace.responses.map(r => r.status)).toEqual([200,200,200,200,200]); await expect(page.getByRole('alert')).toHaveCount(0);
});
test('a bounded grants timeout has a scoped retry, while genuine departure still denies the current session',async ({ page,request }) => {
  const trace = await traceLoad(page,async () => { await request.post('/mock/access-fault',{ data: { mode: 'timeout' } }); }); await signIn(page);
  await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect(page.locator('#access').getByRole('alert')).toContainText('verification is temporarily unavailable',{ timeout: 10000 });
  expect(trace.responses.find(r => r.route === 'grants')?.status).toBe(503);
  await request.post('/mock/leave'); await page.getByRole('button',{ name: 'Retry loading grants' }).click();
  await expect(page.locator('#access').getByRole('alert')).toContainText('server access was denied');
  await page.reload(); await expect(page.getByRole('alert')).toContainText('server access was denied'); await expect(page.getByLabel('Shared personality')).toHaveCount(0);
});
