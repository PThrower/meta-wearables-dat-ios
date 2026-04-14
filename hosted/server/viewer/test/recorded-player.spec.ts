/**
 * Recorded video player e2e — play, close, overlay behavior
 */

import { test, expect, mockConfig, MOCK_GALLERY_SESSIONS } from "./helpers";

test.describe("Recorded video player", () => {
  test.beforeEach(async ({ page }) => {
    await mockConfig(page);
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_GALLERY_SESSIONS) }),
    );
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(3);
  });

  test("clicking Play opens video player overlay", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);
  });

  test("video element has src after play", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    const video = page.locator("#recVideo");
    const src = await video.getAttribute("src");
    expect(src).toBeTruthy();
    // In noAuth mode, authUrl returns URL as-is (no token appended)
    expect(src).toContain("/session/");
  });

  test("close button hides video player", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);

    await page.locator("#closeVideoBtn").click();
    await expect(page.locator("#videoPlayer")).not.toHaveClass(/active/);
  });

  test("clicking overlay background closes video player", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);

    // Click on the overlay itself (not the video)
    await page.locator("#videoPlayer").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("#videoPlayer")).not.toHaveClass(/active/);
  });

  test("video is paused and src cleared on close", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);

    await page.locator("#closeVideoBtn").click();

    const video = page.locator("#recVideo");
    const paused = await video.evaluate((v: HTMLVideoElement) => v.paused);
    expect(paused).toBe(true);

    const src = await video.getAttribute("src");
    expect(src).toBe("");
  });

  test("gallery remains visible behind video overlay", async ({ page }) => {
    await page.locator('[data-action="play"]').first().click();
    // Gallery should still be in the DOM (not hidden like live player)
    await expect(page.locator("#gallery")).toBeVisible();
  });
});
