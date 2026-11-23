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

function buildDetail(requiredCollateral: string) {
  return {
    importer: mockImporter,
    onChainAccount: {
      bondId: '654321',
      collateralBalance: '100000000',
      requiredCollateral,
      reserveBalance: '20000000',
      yieldAccrued: '1000000',
      isClawbacked: false,
    },
    events: [],
  };
}

test.describe('tariff exposure', () => {
  test('uploading tariff exposure updates the required collateral stat', async ({ page }) => {
    let requiredCollateral = '80000000';
    let uploadedBody: { annualDutyTotal?: number } | null = null;

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
        body: JSON.stringify(buildDetail(requiredCollateral)),
      })
    );
    await page.route(`${API}/importers/imp-1/upload-tariff-csv`, (route) => {
      uploadedBody = route.request().postDataJSON();
      requiredCollateral = '150000000';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          annualDutyTotal: uploadedBody?.annualDutyTotal,
          bondFaceValue: 500000,
          requiredCollateralStroops: requiredCollateral,
          txHash: 'tx-tariff',
          txUrl: null,
        }),
      });
    });

    await page.goto('/login');
    await page.fill('input[type="email"]', 'importer@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app/);

    await expect(page.getByText('8.0000 XLM').first()).toBeVisible();

    const tariffCard = page.locator('#tariff');
    await tariffCard.locator('input[type="number"]').fill('12000000');
    await tariffCard.getByRole('button', { name: 'Apply' }).click();

    await expect.poll(() => uploadedBody?.annualDutyTotal).toBe(12000000);
    await expect(page.getByText('15.0000 XLM').first()).toBeVisible();
  });
});
