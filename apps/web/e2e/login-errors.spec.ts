import { test, expect } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

test.describe('login errors', () => {
  test('incorrect password shows an error and stays on /login', async ({ page }) => {
    await page.route(`${API}/auth/login`, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid email or password' }),
      })
    );

    await page.goto('/login');
    await page.fill('input[type="email"]', 'importer@test.com');
    await page.fill('input[type="password"]', 'wrong-password');
    await page.click('button[type="submit"]');

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: /log in/i })).toBeVisible();
  });
});
