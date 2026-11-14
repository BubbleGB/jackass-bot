import { test,expect } from '@playwright/test';
const guild = '222222222222222222';
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
async function signIn(page: import('@playwright/test').Page,as = 'owner',path = '/servers') {
  await page.goto(`/auth/discord?returnTo=${encodeURIComponent(path)}`);
  await page.getByRole('button',{ name: as === 'owner' ? 'Continue as owner' : 'Continue as delegate' }).click();
}
async function noOverflow(page: import('@playwright/test').Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
test('landing and server selector explain approval/privacy and fit the viewport',async ({ page },info) => {
  await page.goto('/'); await expect(page.getByRole('heading',{ name: /A little cosmic chaos/ })).toBeVisible();
  await expect(page.getByRole('link',{ name: 'Add to server',exact: true })).toHaveAttribute('href',/discord.com/);
  await expect(page.getByText(/owners contact the creator/i)).toBeVisible(); await expect(page.getByText(/recent channel messages may be sent/i)).toBeVisible();
  expect(await page.getByRole('img',{ name: /gold cosmic mascot/ }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await noOverflow(page); await page.screenshot({ path: `test-results/screenshots/${info.project.name}-landing.png`,fullPage: true });
  await signIn(page); await expect(page.getByRole('link',{ name: /Bubble Galaxy/ })).toBeVisible(); await noOverflow(page);
  await page.screenshot({ path: `test-results/screenshots/${info.project.name}-servers.png`,fullPage: true });
});
test('Task6 deep link, mobile validation/save, zero history and safely rendered personality',async ({ page },info) => {
  await page.goto(`/servers/${guild}`); await page.getByRole('link',{ name: 'Sign in with Discord',exact: true }).click(); await page.getByRole('button',{ name: 'Continue as owner' }).click();
  await expect(page).toHaveURL(new RegExp(`/servers/${guild}$`));
  const text = '<img src=x onerror="window.evil=1"> Friendly cosmic jokes.';
  await page.getByLabel('Shared personality').fill(text); await page.getByLabel('Previous human messages').fill('0');
  await page.getByLabel('Direct responses across the server').check(); await page.getByLabel('#general',{ exact: true }).check();
  await page.getByLabel('Participation mode').selectOption('always'); await page.getByLabel('Minimum gap (seconds)').fill('90');
  await page.getByLabel('Previous Neegy messages').fill('2'); await page.getByLabel('Visible answer target (tokens)').fill('250'); await page.getByLabel('Total generation limit (tokens)').fill('1024');
  await page.getByLabel('Message threshold').fill('0'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Message threshold');
  await page.getByLabel('Message threshold').fill('31'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.reload(); await expect(page.getByLabel('Shared personality')).toHaveValue(text); await expect(page.getByLabel('Previous human messages')).toHaveValue('0');
  await expect(page.getByLabel('Direct responses across the server')).toBeChecked(); await expect(page.getByLabel('#general',{ exact: true })).toBeChecked();
  await expect(page.getByLabel('Participation mode')).toHaveValue('always'); await expect(page.getByLabel('Minimum gap (seconds)')).toHaveValue('90');
  expect(await page.evaluate(() => (window as unknown as { evil?: number }).evil)).toBeUndefined(); await expect(page.getByText(/current question is always included/i)).toBeVisible();
  await page.getByLabel('Shared personality').fill('Friendly cosmic banter. Keep replies concise, playful and kind.');
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await noOverflow(page); await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: document.documentElement.scrollHeight,behavior: 'instant' }); });
  await page.screenshot({ path: `test-results/screenshots/${info.project.name}-settings.png`,fullPage: true });
  await page.getByRole('button',{ name: 'Save changes',exact: true }).focus(); await expect(page.getByRole('button',{ name: 'Save changes',exact: true })).toBeFocused();
});
test('preserves draft after reload and recovers explicitly from concurrent staff edits',async ({ page,request }) => {
  await signIn(page,'owner',`/servers/${guild}`); await page.getByLabel('Shared personality').fill('My unsaved cosmic draft');
  await page.reload(); await expect(page.getByLabel('Shared personality')).toHaveValue('My unsaved cosmic draft');
  await request.post('/mock/concurrent'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another staff member'); await expect(page.getByText('Theirs: Their newer personality',{ exact: true })).toBeVisible();
  await expect(page.getByLabel('Shared personality')).toHaveValue('My unsaved cosmic draft');
  await page.getByRole('button',{ name: 'Keep my edits on latest revision' }).click(); await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved'); await expect(page.getByLabel('Message threshold')).toHaveValue('44');
});
test('delegates see write-only keys and cannot raise allowances or manage access',async ({ page }) => {
  await signIn(page,'delegate',`/servers/${guild}`); await expect(page.getByText(/Delegated access/)).toBeVisible();
  await expect(page.getByLabel('OpenAI API key')).toBeDisabled(); await expect(page.getByRole('button',{ name: 'Grant access',exact: true })).toHaveCount(0);
  await page.getByLabel('OpenAI daily token allowance').fill('4000'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.getByLabel('OpenAI daily token allowance').fill('6000'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('alert')).toContainText('lower');
  expect(await page.content()).not.toContain('fake-provider-secret');
});
test('creator approvals and access loss leave a clear sign-in/access recovery path',async ({ page,request }) => {
  await signIn(page); await page.getByRole('link',{ name: 'Creator approvals' }).click(); await expect(page.getByRole('heading',{ name: 'Server approvals' })).toBeVisible();
  await page.goto(`/servers/${guild}`); await expect(page.getByLabel('Shared personality')).toBeVisible(); await request.post('/mock/leave');
  await page.reload(); await expect(page.getByRole('alert')).toContainText('access');
});

test('locks the editor during a pending save so later typing cannot be silently discarded',async ({ page }) => {
  await signIn(page,'owner',`/servers/${guild}`);
  await page.getByLabel('Shared personality').fill('First submitted version');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/guilds/${guild}/settings`,async route => { if (route.request().method() === 'PATCH') await gate; await route.continue(); });
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  try { await expect(page.getByLabel('Shared personality')).toBeDisabled(); }
  finally { release(); }
  await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.getByLabel('Shared personality').fill('Next unsaved edit'); await page.reload(); await expect(page.getByLabel('Shared personality')).toHaveValue('Next unsaved edit');
});
test('wraps long Discord names and refreshes remaining allowance after saving',async ({ page }) => {
  await page.route('**/api/servers',async route => { const r = await route.fetch(),b = await r.json(); b.servers[0].name = 'A'.repeat(100); await route.fulfill({ response: r,json: b }); });
  await signIn(page); await expect(page.getByRole('link',{ name: /AAAA/ })).toBeVisible(); await noOverflow(page);
  await page.goto(`/servers/${guild}`); await page.getByLabel('OpenAI daily token allowance').fill('4000'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved'); await expect(page.locator('.metric').first()).toHaveText('4,000');
});

test('configures both providers with only supported effort settings and keeps backend files private',async ({ page,request }) => {
  expect((await request.get('/auth.js')).status()).toBe(404);
  await signIn(page,'owner',`/servers/${guild}`); await page.getByLabel('Google API key').fill('fake-google-key'); await page.getByRole('button',{ name: 'Save Google key',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Change confirmed'); await page.getByLabel('Google model').selectOption('gemini-3.5-flash-lite');
  await page.getByLabel('Google effort').selectOption('minimal'); await expect(page.getByLabel('Google effort').locator('option[value="xhigh"]')).toHaveCount(0);
  await page.getByLabel('Google priority').selectOption('1'); await page.getByLabel('Google daily token allowance').fill('3500'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved'); await page.reload(); await expect(page.getByLabel('Google effort')).toHaveValue('minimal'); await expect(page.getByLabel('OpenAI priority')).toHaveValue('2');
  expect(await page.content()).not.toContain('fake-google-key');
});

test('keeps provider drafts when another staff member removes that provider',async ({ page,request }) => {
  await signIn(page,'owner',`/servers/${guild}`); await page.getByLabel('OpenAI effort').selectOption('high');
  await request.post('/mock/remove-provider'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another staff member'); await page.getByRole('button',{ name: 'Keep my edits on latest revision' }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft is kept'); await expect(page.getByLabel('OpenAI effort')).toHaveValue('high');
});
