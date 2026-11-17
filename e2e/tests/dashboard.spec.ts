import { expect, type Page, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin';

async function signIn(page: Page, token = ADMIN_TOKEN) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel(/Your name/).fill('E2E Bot');
  await page.getByLabel('Admin token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe.configure({ mode: 'serial' });

test('rejects a wrong admin token', async ({ page }) => {
  await signIn(page, 'wrong');
  await expect(page.getByRole('alert')).toHaveText('Invalid admin token');
});

test('creates a flag, targets a rule, rolls out 30% and records history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await expect(page.getByRole('heading', { name: /Feature flags/ })).toBeVisible();

  await page.getByRole('button', { name: 'New flag' }).click();
  await page.locator('input[name=key]').fill('pricing-page-v2');
  await page.locator('input[name=name]').fill('Pricing page v2');
  await page.getByRole('button', { name: 'Create flag' }).click();
  await expect(page).toHaveURL(/\/flags\/pricing-page-v2$/);

  await page.getByRole('switch').click();
  await page.getByRole('button', { name: '+ Add rule' }).click();
  await page.locator('.rule-desc').fill('Internal staff');
  await page.locator('.clause .attr').fill('email');
  await page.locator('.clause .attr').dispatchEvent('change');
  await page.locator('.clause select').nth(1).selectOption('endsWith');
  await page.locator('.clause .vals').fill('@acme.com');
  await page.locator('.clause .vals').dispatchEvent('change');
  const defaultRule = page.locator('.card', { has: page.getByRole('heading', { name: 'Default rule' }) });
  await defaultRule.locator('select').selectOption('rollout');
  const pct = defaultRule.locator('.pct input');
  await pct.nth(0).fill('70');
  await pct.nth(0).dispatchEvent('change');
  await pct.nth(1).fill('30');
  await pct.nth(1).dispatchEvent('change');
  await expect(defaultRule.locator('.sum')).toHaveText('= 100%');

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.savebar')).not.toHaveClass(/visible/);
  await expect(page.locator('.audit li').first()).toContainText('E2E Bot turned on');

  await page.getByRole('button', { name: 'Evaluate' }).click();
  await expect(page.locator('.explain')).toContainText('matched rule 1 "Internal staff"');
  expect(errors).toEqual([]);
});

test('surfaces a conflict when someone else saved first', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/flags/pricing-page-v2');
  await expect(page.getByRole('switch')).toBeVisible();

  // A teammate saves behind our back
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'x-actor': 'Teammate' };
  const flag = await (await request.get('/api/flags/pricing-page-v2', { headers })).json();
  const { updatedAt: _ignored, ...cfg } = flag.envs.production;
  expect((await request.put('/api/flags/pricing-page-v2/envs/production', { headers, data: cfg })).ok()).toBe(true);

  await page.getByRole('switch').click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.savebar .error')).toContainText('changed by someone else');
});

test('generates an SDK key that is shown exactly once', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Environments' }).click();
  const row = page.locator('.flag-row', { hasText: 'development' });
  await row.getByRole('button', { name: 'Generate key' }).click();
  await expect(page.locator('.reveal code')).toHaveText(/^fs_sdk_/);
  await page.reload();
  await expect(page.locator('.reveal')).toHaveCount(0);
  await expect(row).toContainText('fs_sdk_…');
});
