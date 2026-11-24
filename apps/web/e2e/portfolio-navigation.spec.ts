import { test, expect } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

const mockSuretyUser = {
  id: 'surety-1',
  email: 'surety@test.com',
  role: 'surety' as const
};

const mockImporters = [
  {
    id: 'imp-1',
    legalName: 'Test Importer One LLC',
    ein: null,
    bondId: '654321',
    stellarAddress: 'GXYZ5678',
    registeredOnChainTx: 'txhash456',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'imp-2',
    legalName: 'Test Importer Two Corp',
    ein: null,
    bondId: '654322',
    stellarAddress: 'GABC1234',
    registeredOnChainTx: 'txhash789',
    createdAt: new Date().toISOString(),
  },
];

const mockImporterDetail = {
  importer: mockImporters[0],
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
  ],
};

test.describe('portfolio navigation', () => {
  test('surety admin navigates from portfolio list to importer detail page via row link', async ({ page }) => {
    // Mock authentication
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', user: mockSuretyUser }),
      })
    );

    // Mock portfolio list
    await page.route(`${API}/importers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ importers: mockImporters }),
      })
    );

    // Mock importer detail
    await page.route(`${API}/importers/imp-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockImporterDetail),
      })
    );

    // Login
    await page.goto('/login');
    await page.fill('input[type="email"]', 'surety@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    // Wait for redirect to portfolio
    await expect(page).toHaveURL(/\/app/);

    // Verify portfolio list is visible
    await expect(page.getByText(/portfolio/i)).toBeVisible();

    // Verify importers are listed
    await expect(page.getByText('Test Importer One LLC')).toBeVisible();
    await expect(page.getByText('Test Importer Two Corp')).toBeVisible();

    // Click on the first importer row to navigate to detail
    await page.getByText('Test Importer One LLC').click();

    // Verify navigation to detail page
    await expect(page).toHaveURL(/\/app\/importers\/imp-1/);

    // Verify detail page content
    await expect(page.getByText('Test Importer One LLC')).toBeVisible();
    await expect(page.getByText(/bond utilization/i)).toBeVisible();
  });

  test('surety admin views multiple importers in portfolio list', async ({ page }) => {
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', user: mockSuretyUser }),
      })
    );

    await page.route(`${API}/importers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ importers: mockImporters }),
      })
    );

    await page.goto('/login');
    await page.fill('input[type="email"]', 'surety@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    // Verify portfolio displays all importers
    await expect(page.getByText('Test Importer One LLC')).toBeVisible();
    await expect(page.getByText('Test Importer Two Corp')).toBeVisible();

    // Verify table/list structure
    const rows = page.locator('[role="row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(mockImporters.length);
  });
});
