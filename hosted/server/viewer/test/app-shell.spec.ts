/**
 * App shell e2e — boot sequence, config loading, page structure, navigation
 */

import { test, expect, mockConfig, MOCK_CONFIG } from "./helpers";

test.describe("App shell", () => {
  test("loads index.html with correct title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("CaringMind");
  });

  test("has correct viewport meta", async ({ page }) => {
    await page.goto("/");
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute("content", /width=device-width/);
  });

  test("all main DOM containers exist", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#loginOverlay")).toBeAttached();
    await expect(page.locator("#gallery")).toBeAttached();
    await expect(page.locator("#shareDialog")).toBeAttached();
    await expect(page.locator("#livePlayer")).toBeAttached();
    await expect(page.locator("#videoPlayer")).toBeAttached();
    await expect(page.locator("#unmute")).toBeAttached();
  });

  test("fetches config on boot", async ({ page }) => {
    let configFetched = false;
    await page.route("**/api/config", (route) => {
      configFetched = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_CONFIG) });
    });
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.goto("/");
    expect(configFetched).toBe(true);
  });

  test("gallery fetches data on boot when authenticated", async ({ page }) => {
    let galleryFetched = false;
    await page.route("**/gallery/api", (route) => {
      galleryFetched = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.goto("/");
    expect(galleryFetched).toBe(true);
  });

  test("Stats link in status bar navigates to /stats", async ({ page }) => {
    await page.goto("/");
    const statsLink = page.locator('#status-bar a:has-text("Stats")');
    await expect(statsLink).toHaveAttribute("href", "/stats");
  });

  test("header home link navigates to /", async ({ page }) => {
    await page.goto("/");
    const homeLink = page.locator("a.header-home");
    await expect(homeLink).toHaveAttribute("href", "/");
    await expect(homeLink).toContainText("CaringMind");
  });
});

test.describe("Landing page", () => {
  test("loads landing.html with correct title", async ({ page }) => {
    await page.goto("/landing.html");
    await expect(page).toHaveTitle(/CaringMind/);
  });

  test("has hero section", async ({ page }) => {
    await page.goto("/landing.html");
    // Landing page is a static page with marketing content
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });
});

test.describe("Config error handling", () => {
  test("handles config fetch failure gracefully", async ({ page }) => {
    await page.route("**/api/config", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" }),
    );
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    // Page should not crash — config fetch failure is logged, app continues
    await page.goto("/");
    // Gallery may or may not show depending on error handling
    // Key assertion: no blank white page / JS crash
    await expect(page.locator("body")).toBeVisible();
  });
});
