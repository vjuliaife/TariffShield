import { test, expect } from "@playwright/test";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

const mockUser = { id: "user-1", email: "importer@test.com", role: "importer" as const };
const mockImporter = {
  id: "imp-1",
  legalName: "Test Importer LLC",
  ein: null,
  bondId: "654321",
  stellarAddress: "GXYZ5678",
  registeredOnChainTx: "txhash456",
  createdAt: new Date().toISOString(),
};
const mockDetail = {
  importer: mockImporter,
  onChainAccount: {
    bondId: "654321",
    collateralBalance: "100000000",
    requiredCollateral: "80000000",
    reserveBalance: "20000000",
    yieldAccrued: "1000000",
    isClawbacked: false,
  },
  events: [
    {
      id: "evt-1",
      kind: "Deposit",
      amount: "100000000",
      txHash: "txhash789",
      txUrl: null,
      createdAt: new Date().toISOString(),
    },
  ],
};

test.describe("dashboard loads", () => {
  test("unauthenticated /app redirects to /login", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });

  test("dashboard renders bond stats after login", async ({ page }) => {
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-token", user: mockUser }),
      }),
    );
    await page.route(`${API}/importers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importers: [mockImporter] }),
      }),
    );
    await page.route(`${API}/importers/imp-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockDetail),
      }),
    );

    await page.goto("/login");
    await page.fill('input[type="email"]', "importer@test.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/app/);

    // Bond utilization bar section
    await expect(page.getByText(/bond utilization/i)).toBeVisible();

    // On-chain event log section
    await expect(
      page.getByRole("heading", { name: /on-chain event log/i }),
    ).toBeVisible();

    // Event entry
    await expect(page.getByText("Deposit")).toBeVisible();
  });

  test("dashboard shows collateral stats", async ({ page }) => {
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-token", user: mockUser }),
      }),
    );
    await page.route(`${API}/importers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importers: [mockImporter] }),
      }),
    );
    await page.route(`${API}/importers/imp-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockDetail),
      }),
    );

    await page.goto("/login");
    await page.fill('input[type="email"]', "importer@test.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');

    await expect(page.getByText(/required collateral/i)).toBeVisible();
    await expect(page.getByText(/posted collateral/i)).toBeVisible();
    await expect(page.getByText(/reserve/i).first()).toBeVisible();
    await expect(page.getByText(/yield accrued/i)).toBeVisible();
  });
});
