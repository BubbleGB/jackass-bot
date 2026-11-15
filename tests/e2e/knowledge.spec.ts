import { test,expect,type Page } from '@playwright/test';
const guild = '222222222222222222',path = `/servers/${guild}/knowledge`,apiPath = `/api/guilds/${guild}/knowledge`;
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
async function login(page: Page) { await page.goto(`/auth/discord?returnTo=${path}`); await page.getByRole('button',{ name: 'Continue as owner' }).click(); await expect(page.getByRole('heading',{ name: 'Server knowledge',exact: true })).toBeVisible(); }
async function write(page: Page,method: 'POST' | 'PATCH' | 'DELETE',suffix: string,body: unknown) {
  const session = await (await page.request.get('/api/session')).json();
  const r = await page.request.fetch(apiPath+suffix,{ method,data: body,headers: { 'x-csrf-token': session.csrf,origin: 'http://127.0.0.1:4173' } }); expect(r.ok()).toBe(true); return r.status() === 204 ? undefined : r.json();
}
async function create(page: Page,title = 'Server guide',body = 'Our local plain-text guide') { await page.getByRole('button',{ name: 'New entry',exact: true }).click(); await page.getByLabel('Entry title',{ exact: true }).fill(title); await page.getByLabel('Knowledge text',{ exact: true }).fill(body); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry saved'); }
test('direct sign-in preserves the knowledge deep link and supports large Unicode CRUD',async ({ page },info) => {
  await page.goto(path); await page.getByRole('link',{ name: 'Sign in with Discord' }).click(); await page.getByRole('button',{ name: 'Continue as owner' }).click(); await expect(page).toHaveURL(path);
  await expect(page.getByRole('heading',{ name: 'Server knowledge',exact: true })).toBeVisible(); await page.evaluate(() => window.scrollTo({ top: 0,behavior: 'instant' })); await page.screenshot({ path: `test-results/screenshots/knowledge-${info.project.name}-list.png`,fullPage: true });
  const large = 'Server reference. '.repeat(4000)+'🌌'; expect(Array.from(large).length).toBeGreaterThanOrEqual(60000);
  await create(page,'Cosmic guide',large); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue(large); await expect(page.getByText('72,001 / 100,000 characters',{ exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0,behavior: 'instant' })); await page.screenshot({ path: `test-results/screenshots/knowledge-${info.project.name}-editor.png`,fullPage: true });
  await expect(page.getByLabel('Knowledge text',{ exact: true })).not.toHaveAttribute('maxlength');
  expect(await page.getByLabel('Knowledge text',{ exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.getByLabel('Use this entry in AI responses').uncheck(); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry saved');
  await page.reload(); await page.getByRole('button',{ name: /Cosmic guide/ }).click(); await expect(page.getByLabel('Use this entry in AI responses')).not.toBeChecked();
  page.once('dialog',d => d.accept()); await page.getByRole('button',{ name: 'Delete entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry deleted'); await expect(page.getByRole('button',{ name: /Cosmic guide/ })).toHaveCount(0);
});
test('validates code point limits without truncation and focuses invalid fields',async ({ page }) => {
  await login(page); await page.getByRole('button',{ name: 'New entry',exact: true }).click(); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByLabel('Entry title',{ exact: true })).toBeFocused();
  await page.getByLabel('Entry title',{ exact: true }).fill('🌌'.repeat(121)); await page.getByLabel('Knowledge text',{ exact: true }).fill('x'); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('alert')).toContainText('120');
  await page.getByLabel('Entry title',{ exact: true }).fill('🌌'.repeat(120)); await page.getByLabel('Knowledge text',{ exact: true }).fill('x'.repeat(100000)+'🌌'); await expect(page.getByText('100,001 / 100,000 characters',{ exact: true })).toBeVisible(); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toBeFocused(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('x'.repeat(100000)+'🌌');
});
test('restores a separate draft and read retry never replaces it',async ({ page }) => {
  await login(page); await create(page); await page.getByLabel('Knowledge text',{ exact: true }).fill('Unsaved Unicode 🌌 draft');
  page.once('dialog',d => d.accept()); await page.reload(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Unsaved Unicode 🌌 draft');
  let broken = true; await page.route(`**${apiPath}`,r => broken && r.request().method() === 'GET' ? r.fulfill({ status: 503,json: { error: 'storage_failed' } }) : r.continue());
  await page.getByRole('button',{ name: 'Refresh entries',exact: true }).click(); await expect(page.getByRole('alert')).toContainText('temporarily unavailable'); broken = false; await page.getByRole('button',{ name: 'Retry loading entries',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Unsaved Unicode 🌌 draft');
  page.once('dialog',d => d.dismiss()); await page.getByRole('button',{ name: 'New entry',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Unsaved Unicode 🌌 draft');
});
test('conflicts preserve the draft, retry latest separately, and require explicit revision choice',async ({ page },info) => {
  await login(page); await create(page); const { entries } = await (await page.request.get(apiPath)).json(); const entry = entries[0];
  await page.getByLabel('Knowledge text',{ exact: true }).fill('My pending edits'); await write(page,'PATCH',`/${entry.id}`,{ revision: entry.revision,patch: { body: 'Their newer text' } });
  let broken = true; await page.route(`**${apiPath}/${entry.id}`,r => broken && r.request().method() === 'GET' ? r.fulfill({ status: 503,json: { error: 'storage_failed' } }) : r.continue());
  await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('button',{ name: 'Retry loading latest entry',exact: true })).toBeVisible(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('My pending edits'); broken = false; await page.getByRole('button',{ name: 'Retry loading latest entry',exact: true }).click();
  await expect(page.getByText('Their newer text',{ exact: true })).toBeVisible(); await page.evaluate(() => window.scrollTo({ top: 0,behavior: 'instant' })); await page.screenshot({ path: `test-results/screenshots/knowledge-${info.project.name}-conflict.png`,fullPage: true });
  await page.getByRole('button',{ name: 'Keep my draft on latest revision',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('My pending edits'); expect((await (await page.request.get(`${apiPath}/${entry.id}`)).json()).entry.body).toBe('Their newer text');
  await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry saved'); expect((await (await page.request.get(`${apiPath}/${entry.id}`)).json()).entry.body).toBe('My pending edits');
});
test('deleted entries retain edits and offer explicit save as new',async ({ page }) => {
  await login(page); await create(page); const { entries } = await (await page.request.get(apiPath)).json(); await page.getByLabel('Knowledge text',{ exact: true }).fill('Keep this orphan draft'); await write(page,'DELETE',`/${entries[0].id}`,{ revision: entries[0].revision });
  await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Keep this orphan draft'); await page.getByRole('button',{ name: 'Save as new entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry saved');
});
test('settings expose the budget and preserve legacy drafts',async ({ page }) => {
  await login(page); await page.goto(`/servers/${guild}`); const input = page.getByLabel('Knowledge token budget',{ exact: true }); await expect(input).toHaveValue('2000');
  await input.fill('8001'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('alert')).toContainText('8000');
  await input.fill('1234'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved'); await page.reload(); await expect(input).toHaveValue('1234');
  const settings = (await (await page.request.get(`/api/guilds/${guild}/settings`)).json()).settings; const session = await (await page.request.get('/api/session')).json(); delete settings.knowledgeTokenLimit;
  await page.evaluate(({ settings,key }) => { sessionStorage.setItem(key,JSON.stringify({ base: settings,draft: { ...settings,instructions: 'Legacy unsaved personality' } })); },{ settings,key: `gn-draft:${session.userId}:${guild}` }); await page.reload(); await expect(input).toHaveValue('1234'); await expect(page.getByLabel('Shared personality')).toHaveValue('Legacy unsaved personality');
});
test('plain text stays inert and storage failure keeps edits honestly in memory',async ({ page }) => {
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key,value) { if (key.startsWith('gn-draft:knowledge:')) throw new DOMException('Storage unavailable','QuotaExceededError'); write.call(this,key,value); };
  });
  await login(page); await page.getByRole('button',{ name: 'New entry',exact: true }).click(); await page.getByLabel('Entry title',{ exact: true }).fill('<img src=x onerror=alert(1)>'); await page.getByLabel('Knowledge text',{ exact: true }).fill('<script>alert("not executed")</script> 🌌');
  await expect(page.getByRole('alert')).toContainText('kept in memory'); await expect(page.getByRole('status')).toContainText('Unsaved draft'); await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Entry saved'); await expect(page.getByRole('button',{ name: /<img src=x onerror=alert\(1\)>/ })).toBeVisible(); await expect(page.locator('.knowledge-list img,.knowledge-list script')).toHaveCount(0);
  await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('<script>alert("not executed")</script> 🌌');
});
test('load latest explicitly discards a conflicting draft and entry reads can retry',async ({ page }) => {
  await login(page); await create(page); const { entries } = await (await page.request.get(apiPath)).json(); const entry = entries[0]; await page.getByLabel('Knowledge text',{ exact: true }).fill('My draft to discard'); await write(page,'PATCH',`/${entry.id}`,{ revision: entry.revision,patch: { title: 'Latest guide',body: 'Latest authoritative plain text' } });
  await page.getByRole('button',{ name: 'Save entry',exact: true }).click(); await page.getByRole('button',{ name: 'Load latest and discard my draft',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Latest authoritative plain text');
  await page.getByRole('button',{ name: 'New entry',exact: true }).click(); let broken = true; await page.route(`**${apiPath}/${entry.id}`,r => broken && r.request().method() === 'GET' ? r.fulfill({ status: 503,json: { error: 'storage_failed' } }) : r.continue()); await page.getByRole('button',{ name: /Server guide|Latest guide/ }).click(); await expect(page.getByRole('button',{ name: 'Retry loading entry',exact: true })).toBeVisible(); broken = false; await page.getByRole('button',{ name: 'Retry loading entry',exact: true }).click(); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Latest authoritative plain text');
});

test('knowledge drafts stay independent from settings and logout clears both',async ({ page }) => {
  await login(page); await create(page); await page.getByLabel('Knowledge text',{ exact: true }).fill('Independent knowledge draft'); page.once('dialog',d => d.accept()); await page.goto(`/servers/${guild}`); await page.getByLabel('Shared personality').fill('Independent settings draft'); page.once('dialog',d => d.accept()); await page.goto(path); await expect(page.getByLabel('Knowledge text',{ exact: true })).toHaveValue('Independent knowledge draft');
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('gn-draft:')).length)).toBe(2); page.once('dialog',d => d.accept()); await page.getByRole('button',{ name: 'Sign out',exact: true }).click(); await expect(page).toHaveURL('/'); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('gn-draft:')))).toEqual([]);
});
