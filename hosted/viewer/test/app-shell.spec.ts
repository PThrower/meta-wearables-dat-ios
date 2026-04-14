/**
 * App shell e2e — boot sequence, config loading, page structure, navigation
 */

import { test, expect, MOCK_CONFIG } from "./helpers";

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

  test("gallery fetches data on boot", async ({ page }) => {
    let galleryFetched = false;
    await page.route("**/gallery/api", (route) => {
      galleryFetched = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    expect(galleryFetched).toBe(true);
  });

  test("Stats link in status bar points to /stats", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('#status-bar a:has-text("Stats")')).toHaveAttribute("href", "/stats");
  });

  test("header home link navigates to /", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("a.header-home")).toHaveAttribute("href", "/");
    await expect(page.locator("a.header-home")).toContainText("CaringMind");
  });
});

test.describe("Landing page", () => {
  test("loads landing.html", async ({ page }) => {
    await page.goto("/landing.html");
    await expect(page).toHaveTitle(/CaringMind/);
  });

  test("landing page body renders", async ({ page }) => {
    await page.goto("/landing.html");
    await expect(page.locator("body")).toBeVisible();
  });
});
