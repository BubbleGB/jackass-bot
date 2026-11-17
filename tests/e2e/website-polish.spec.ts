import { test,expect,type Page } from '@playwright/test';

const guild = '222222222222222222';
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
async function login(page: Page,path = '/servers') {
  await page.goto(`/auth/discord?returnTo=${encodeURIComponent(path)}`);
  await page.getByRole('button',{ name: 'Continue as owner' }).click();
}

test('server discovery retries without showing a misleading empty state',async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/servers',route => unavailable ? route.fulfill({ status: 503,json: { error: 'verification_unavailable' } }) : route.continue());
  await login(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('heading',{ name: 'No approved servers available yet.' })).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button',{ name: 'Retry loading servers',exact: true }).click();
  await expect(page.getByRole('link',{ name: /Bubble Galaxy/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('server search stays local, handles no matches and keeps pagination usable',async ({ page }) => {
  let reads = 0;
  await page.route('**/api/servers*',route => {
    reads++;
    const more = new URL(route.request().url()).searchParams.has('after');
    return route.fulfill({ json: { servers: [{ id: guild,name: 'Bubble Galaxy',level: 'creator' },...(more ? [{ id: '777777777777777777',name: 'Second galaxy',level: 'delegate' }] : [])],next: more ? null : guild } });
  });
  await login(page);
  const search = page.getByRole('searchbox',{ name: 'Search loaded servers' });
  await search.fill('missing');
  await expect(page.getByText('No matching servers.',{ exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole('button',{ name: 'Check more servers',exact: true }).click();
  await page.getByRole('button',{ name: 'Clear search',exact: true }).click();
  await expect(page.getByRole('link',{ name: /Second galaxy/ })).toBeVisible();
  await search.fill('BUBBLE');
  await expect(page.getByRole('link',{ name: /Bubble Galaxy/ })).toHaveCount(1);
  await expect(page.getByRole('link',{ name: /Bubble Galaxy/ })).toBeVisible();
  await expect(page.getByRole('link',{ name: /Second galaxy/ })).toHaveCount(0);
  expect(reads).toBe(2);
});

test('a failed next page keeps loaded servers and retries the same cursor',async ({ page }) => {
  const requests: string[] = [];
  let failNext = true;
  await page.route('**/api/servers*',route => {
    const after = new URL(route.request().url()).searchParams.get('after') ?? '';
    requests.push(after);
    if (after && failNext) return route.fulfill({ status: 503,json: { error: 'storage_failed' } });
    return route.fulfill({ json: { servers: [{ id: after || guild,name: after ? 'Second galaxy' : 'Bubble Galaxy',level: 'creator' }],next: after ? null : '777777777777777777' } });
  });
  await login(page);
  await page.getByRole('button',{ name: 'Check more servers',exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('link',{ name: /Bubble Galaxy/ })).toBeVisible();
  failNext = false;
  await page.getByRole('button',{ name: 'Retry loading servers',exact: true }).click();
  await expect(page.getByRole('link',{ name: /Second galaxy/ })).toBeVisible();
  expect(requests).toEqual(['','777777777777777777','777777777777777777']);
});

test('knowledge search preserves an unsaved editor and new entries remain reachable',async ({ page }) => {
  await login(page,`/servers/${guild}/knowledge`);
  await page.getByRole('button',{ name: 'New entry',exact: true }).click();
  await page.getByLabel('Entry title',{ exact: true }).fill('Server guide');
  await page.getByLabel('Knowledge text',{ exact: true }).fill('Our local reference');
  await page.getByRole('button',{ name: 'Save entry',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Entry saved');
  await page.getByLabel('Knowledge text',{ exact: true }).fill('An unsaved revision 🌌');
  await page.getByRole('searchbox',{ name: 'Search entries' }).fill('nothing');
  await expect(page.getByText('No matching entries.',{ exact: true })).toBeVisible();
  await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('An unsaved revision 🌌');
  await page.getByRole('button',{ name: 'Clear entry search',exact: true }).click();
  await expect(page.getByRole('button',{ name: /Server guide/ })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('An unsaved revision 🌌');
});

test('public guidance and settings navigation work with keyboard and reduced motion',async ({ page },info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link',{ name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByText('Do I need my own AI provider key?',{ exact: true }).click();
  await expect(page.getByText(/The bot does not include a funded AI allowance/)).toBeVisible();
  await login(page,`/servers/${guild}`);
  await expect(page.getByRole('heading',{ name: 'Conversation history',exact: true })).toBeVisible();
  await page.getByRole('navigation',{ name: 'Settings sections' }).getByRole('link',{ name: 'Providers',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'AI providers',exact: true })).toBeInViewport();
  await page.getByLabel('Shared personality').fill('A clearer cosmic voice');
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0,behavior: 'instant' }); });
  await page.screenshot({ path: `test-results/screenshots/${info.project.name}-polished-settings.png`,fullPage: true });
});


test('small screens and enlarged text keep settings controls reachable',async ({ page }) => {
  await page.setViewportSize({ width: 320,height: 740 });
  await login(page,`/servers/${guild}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
  await expect(page.getByLabel('Shared personality')).toBeVisible();
  await page.getByLabel('Message threshold').fill('35');
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('navigation',{ name: 'Settings sections' }).getByRole('link',{ name: 'Access',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'Dashboard access',exact: true })).toBeInViewport();
});

test('AI state badge changes only after a successful save',async ({ page }) => {
  await login(page,`/servers/${guild}`);
  await page.getByLabel('Enable AI for this server',{ exact: true }).check();
  await expect(page.getByText('AI paused',{ exact: true })).toBeVisible();
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved');
  await expect(page.getByText('AI enabled',{ exact: true })).toBeVisible();
});
