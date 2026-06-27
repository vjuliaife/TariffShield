import { test, expect } from "@playwright/test";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

const mockUser = { id: "user-2", email: "new@test.com", role: "importer" as const };
const mockImporter = {
  id: "imp-2",
  legalName: "Global Goods Corp",
  ein: "98-7654321",
  bondId: "999001",
  stellarAddress: "GAAA0001",
  registeredOnChainTx: "txonboard1",
  createdAt: new Date().toISOString(),
};
const mockDetail = {
  importer: mockImporter,
  onChainAccount: {
    bondId: "999001",
    collateralBalance: "25000000",
    requiredCollateral: "25000000",
    reserveBalance: "5000000",
    yieldAccrued: "0",
    isClawbacked: false,
  },
  events: [],
};

test.describe("importer onboarding", () => {
  test("full happy path: sign up → register → see dashboard", async ({ page }) => {
    // Mock signup
    await page.route(`${API}/auth/signup`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "onboard-token", user: mockUser }),
      }),
    );

    // Mock importer list — starts empty, returns importer after creation
    let importerCreated = false;
    await page.route(`${API}/importers`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ importers: importerCreated ? [mockImporter] : [] }),
        });
      }
      // POST — create importer
      importerCreated = true;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ importer: mockImporter }),
      });
    });

    // Mock Stellar RPC-related endpoints
    await page.route(`${API}/importers/imp-2`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockDetail),
      }),
    );
    await page.route(`${API}/importers/*/auto-top-up`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ movedStroops: "0", txHash: "tx-au", txUrl: null }),
      }),
    );
    await page.route(`${API}/importers/*/deposit`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ txHash: "tx-dep", txUrl: null }),
      }),
    );
    await page.route(`${API}/importers/*/upload-tariff-csv`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          annualDutyTotal: 5000000,
          bondFaceValue: 500000,
          requiredCollateralStroops: "25000000",
          txHash: "tx-tariff",
          txUrl: null,
        }),
      }),
    );

    // Step 1: Sign up
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
    await page.selectOption("select", "importer");
    await page.fill('input[type="email"]', "new@test.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');

    // Step 2: Registration form shown
    await expect(page).toHaveURL(/\/app/);
    await expect(
      page.getByRole("heading", { name: /register your importer entity/i }),
    ).toBeVisible();

    // Step 3: Fill registration form
    await page.fill('input[placeholder="Wayfair Imports Inc"]', "Global Goods Corp");
    await page.fill('input[placeholder="12-3456789"]', "98-7654321");
    await page.click('button[type="submit"]');

    // Step 4: Dashboard visible with legal name
    await expect(page.getByText("Global Goods Corp")).toBeVisible();

    // Step 5: auto_top_up button is present (no shortfall — should show disabled state)
    await expect(page.getByRole("button", { name: /auto_top_up/i })).toBeVisible();
  });
});
