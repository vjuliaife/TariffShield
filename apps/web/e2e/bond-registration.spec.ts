import { test, expect } from "@playwright/test";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

const mockUser = { id: "user-1", email: "importer@test.com", role: "importer" as const };
const mockToken = "test-token";
const mockImporter = {
  id: "imp-1",
  legalName: "Acme Imports Inc",
  ein: "12-3456789",
  bondId: "123456",
  stellarAddress: "GABC1234",
  registeredOnChainTx: "txhash123",
  createdAt: new Date().toISOString(),
};
const mockDetail = {
  importer: mockImporter,
  onChainAccount: {
    bondId: "123456",
    collateralBalance: "50000000",
    requiredCollateral: "40000000",
    reserveBalance: "10000000",
    yieldAccrued: "500000",
    isClawbacked: false,
  },
  events: [],
};

test.describe("bond registration", () => {
  test.beforeEach(async ({ page }) => {
    // Mock auth endpoints
    await page.route(`${API}/auth/signup`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: mockToken, user: mockUser }),
      }),
    );

    // Mock importer list (initially empty so registration form shows)
    await page.route(`${API}/importers`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ importers: [] }),
        });
      }
      // POST /importers — create importer
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ importer: mockImporter }),
      });
    });

    // Mock individual importer fetch (called after registration)
    await page.route(`${API}/importers/imp-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockDetail),
      }),
    );

    // Mock Stellar RPC-related operations
    await page.route(`${API}/importers/*/auto-top-up`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ movedStroops: "0", txHash: "tx1", txUrl: null }),
      }),
    );
    await page.route(`${API}/importers/*/deposit`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ txHash: "tx2", txUrl: null }),
      }),
    );
    await page.route(`${API}/importers/*/withdraw`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ txHash: "tx3", txUrl: null }),
      }),
    );
  });

  test("shows registration form for new importer", async ({ page }) => {
    // Sign up
    await page.goto("/signup");
    await page.selectOption("select", "importer");
    await page.fill('input[type="email"]', "importer@test.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');

    // Should land on /app showing the registration form
    await expect(page).toHaveURL(/\/app/);
    await expect(
      page.getByRole("heading", { name: /register your importer entity/i }),
    ).toBeVisible();
  });

  test("registration form submits and shows dashboard", async ({ page }) => {
    // Sign up first
    await page.goto("/signup");
    await page.selectOption("select", "importer");
    await page.fill('input[type="email"]', "importer@test.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app/);

    // Fill and submit registration form
    await page.fill('input[placeholder="Wayfair Imports Inc"]', "Acme Imports Inc");
    await page.fill('input[placeholder="12-3456789"]', "12-3456789");

    // After registration, list returns the new importer
    await page.route(`${API}/importers`, (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ importers: [mockImporter] }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ importer: mockImporter }),
      });
    });

    await page.click('button[type="submit"]');

    // Dashboard should show bond stats
    await expect(page.getByText("Acme Imports Inc")).toBeVisible();
    await expect(page.getByText(/required collateral/i)).toBeVisible();
    await expect(page.getByText(/posted collateral/i)).toBeVisible();
  });
});
