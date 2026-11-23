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
  events: [
    {
      id: 'evt-1',
      kind: 'Deposit',
      amount: '100000000',
      txHash: 'txhash789',
      txUrl: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'evt-2',
      kind: 'Withdrawal',
      amount: '50000000',
      txHash: 'txhash790',
      txUrl: null,
      createdAt: new Date(Date.now() - 86400000 * 30).toISOString(), // 30 days ago
    },
  ],
};

test.describe('bond timeline calendar', () => {
  test('navigates to the next month and back via arrow controls', async ({ page }) => {
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

    // Login and navigate to detail page
    await page.goto('/login');
    await page.fill('input[type="email"]', 'importer@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/app/);

    // Verify on-chain event log section exists
    await expect(page.getByRole('heading', { name: /on-chain event log/i })).toBeVisible();

    // Find current month display in calendar
    const currentDate = new Date();
    const currentMonthLabel = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    await expect(page.getByText(currentMonthLabel)).toBeVisible();

    // Click next month arrow
    const nextButton = page.getByRole('button', { name: /next/i }).first();
    await nextButton.click();

    // Verify month changed
    const nextDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1);
    const nextMonthLabel = nextDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    await expect(page.getByText(nextMonthLabel)).toBeVisible();

    // Click previous month arrow to go back
    const prevButton = page.getByRole('button', { name: /previous|back/i }).first();
    await prevButton.click();

    // Verify returned to original month
    await expect(page.getByText(currentMonthLabel)).toBeVisible();
  });

  test('calendar displays events for the selected month', async ({ page }) => {
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

    // Verify events are displayed in the timeline
    await expect(page.getByText('Deposit')).toBeVisible();
    await expect(page.getByText('Withdrawal')).toBeVisible();
  });

  test('month navigation wraps around year boundaries', async ({ page }) => {
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

    // Navigate forward multiple times to test year boundary
    const nextButton = page.getByRole('button', { name: /next/i }).first();
    for (let i = 0; i < 15; i++) {
      await nextButton.click();
      // Verify calendar is still visible and responsive
      await expect(page.getByRole('heading', { name: /on-chain event log/i })).toBeVisible();
    }

    // Navigate backward
    const prevButton = page.getByRole('button', { name: /previous|back/i }).first();
    for (let i = 0; i < 15; i++) {
      await prevButton.click();
      await expect(page.getByRole('heading', { name: /on-chain event log/i })).toBeVisible();
    }
  });
});
