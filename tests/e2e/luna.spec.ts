import { test,expect } from '@playwright/test';
const guild = '222222222222222222',mini = 'gpt-5.4-mini-2026-03-17';
test.beforeEach(async ({ request }) => { await request.post('/mock/reset'); });
test('keeps Mini selected, offers Luna with Galaxy low default and all supported efforts, then saves explicit selection',async ({ page }) => {
  await page.goto(`/auth/discord?returnTo=/servers/${guild}`); await page.getByRole('button',{ name: 'Continue as owner' }).click();
  await expect(page.getByLabel('OpenAI model')).toHaveValue(mini); await page.getByLabel('OpenAI effort').selectOption('high');
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.reload(); await expect(page.getByLabel('OpenAI model')).toHaveValue(mini); await expect(page.getByLabel('OpenAI effort')).toHaveValue('high');
  await page.getByLabel('OpenAI model').selectOption('gpt-6-luna'); await expect(page.getByLabel('OpenAI effort')).toHaveValue('');
  await expect(page.getByLabel('OpenAI effort').locator('option')).toHaveText(['Galaxy default (low)','none','low','medium','high','xhigh','max']);
  await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.reload(); await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-6-luna'); await expect(page.getByLabel('OpenAI effort')).toHaveValue('');
  await expect(page.getByLabel('OpenAI daily token allowance')).toHaveValue('5000');
  await page.getByLabel('OpenAI effort').selectOption('max'); await page.getByRole('button',{ name: 'Save changes',exact: true }).click(); await expect(page.getByRole('status')).toContainText('Changes saved');
  await page.reload(); await expect(page.getByLabel('OpenAI effort')).toHaveValue('max');
});
