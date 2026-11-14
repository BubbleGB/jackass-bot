import { test,expect } from '@playwright/test';
const guild = '222222222222222222';
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
test('repeated full loads succeed under a Discord bucket with bounded upstream reads',async ({ page,request }) => {
  await request.post('/mock/access-fault',{ data: { mode: 'bucket' } });
  await page.goto(`/auth/discord?returnTo=/servers/${guild}`); await page.getByRole('button',{ name: 'Continue as owner' }).click();
  for (let i = 0; i < 4; i++) {
    if (i) await page.reload();
    await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect(page.getByText('Loading current access grants…')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  expect((await (await page.request.get('/mock/access-trace')).json()).discordReads).toBeLessThanOrEqual(36);
});
for (const [route,label] of [['status','usage'],['errors','errors'],['channels','channels']]) test(`optional ${route} failure keeps editor usable and retries without losing edits`,async ({ page }) => {
  let broken = true;
  await page.route(`**/api/guilds/${guild}/${route}`,async r => { if (broken) await r.fulfill({ status: 503,json: { error: 'storage_failed' } }); else await r.continue(); });
  await page.goto(`/auth/discord?returnTo=/servers/${guild}`); await page.getByRole('button',{ name: 'Continue as owner' }).click();
  await expect(page.getByLabel('Shared personality')).toBeVisible(); await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  if (route === 'status') await expect(page.getByText(/Last accounted provider:/)).toHaveCount(0);
  await page.getByLabel('Shared personality').fill('Keep the draft while optional reads recover'); broken = false;
  await page.getByRole('button',{ name: `Retry loading ${label}` }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Shared personality')).toHaveValue('Keep the draft while optional reads recover');
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
});
