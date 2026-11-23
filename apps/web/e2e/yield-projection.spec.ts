import { test, expect } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

const mockUser = { id: 'user-1', email: 'importer@test.com', role: 'importer' as const };
const mockImporter = {
  id: 'imp-1',
  legalName: 'Test Importer LLC',
  ein: null,
  bondId: '654321',
  stellarAddress: 'GXYZ5678',
  registeredOnChainTx: 'txhash456',
  createdAt: new Date().toISOString(),
};
const mockDetail = {
  importer: mockImporter,
  onChainAccount: {
    bondId: '654321',
    collateralBalance: '100000000',
    requiredCollateral: '80000000',
    reserveBalance: '20000000',
    yieldAccrued: '1000000',
    isClawbacked: false,
  },
  events: [],
};

test.describe('yield projection', () => {
  test('projected balance recalculates when inputs change', async ({ page }) => {
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', user: mockUser }),
      })
    );
    await page.route(`${API}/importers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ importers: [mockImporter] }),
      })
    );
    await page.route(`${API}/importers/imp-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDetail),
      })
    );

    await page.goto('/login');
    await page.fill('input[type="email"]', 'importer@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app/);

    const projection = page.locator('p', { hasText: 'Projected balance after' });

    // Worker round-trip completes: result replaces the "Calculating…" state
    await expect(projection).toBeVisible();
    await expect(page.getByText('Calculating…')).toHaveCount(0);
    await expect(projection).toContainText('after 24 months');
    const initialText = await projection.textContent();

    // Changing months re-runs the worker and yields a different projected balance
    await page.getByLabel('Months', { exact: true }).fill('12');
    await expect(projection).toContainText('after 12 months');
    await expect.poll(() => projection.textContent()).not.toEqual(initialText);

    // Zero simulated yield with no top-up means zero yield accrued
    await page.getByLabel('Simulated annual yield (bps)', { exact: true }).fill('0');
    await expect(projection).toContainText('+0.0000 XLM yield');
  });
});
