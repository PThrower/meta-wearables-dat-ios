/**
 * Gallery e2e — gallery rendering, filters, card actions, error handling
 */

import { test, expect, mockGallery, mockGalleryError, MOCK_GALLERY_SESSIONS } from "./helpers";

test.describe("Gallery rendering", () => {
  test("renders session cards from API", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#gallery")).toBeVisible();
    const cards = page.locator(".card");
    await expect(cards).toHaveCount(3);

    // First card = LIVE
    await expect(cards.first().locator(".badge-live")).toBeVisible();

    // Second card = RECORDED
    await expect(cards.nth(1).locator(".badge-recorded")).toBeVisible();

    // Third card (no segments) = no Play button
    await expect(cards.nth(2).locator('[data-action="play"]')).toHaveCount(0);
  });

  test("displays device name and session metadata on cards", async ({ page }) => {
    await page.goto("/");

    const firstCard = page.locator(".card").first();
    await expect(firstCard).toContainText("Meta Ray-Ban");
    await expect(firstCard).toContainText("45s");
    await expect(firstCard).toContainText("session-");

    // Wearable type shown
    await expect(firstCard).toContainText("glasses");

    // Segments / audio chunks
    await expect(firstCard).toContainText("12 vid / 8 aud");
  });

  test("shows Owner badge on owned sessions", async ({ page }) => {
    await page.goto("/");
    const firstCard = page.locator(".card").first();
    await expect(firstCard.locator(".owner-badge")).toBeVisible();
  });

  test("shows lock icon on private sessions", async ({ page }) => {
    await page.goto("/");
    const privateCard = page.locator(".card").last();
    await expect(privateCard.locator(".lock-icon")).toBeVisible();
  });

  test("shows cached/on-demand MP4 status", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator(".card");
    // First card: not cached
    await expect(cards.first()).toContainText("on-demand");
    // Second card: cached
    await expect(cards.nth(1)).toContainText("cached");
  });

  test("updates subtitle with session count and live count", async ({ page }) => {
    await page.goto("/");
    const subtitle = page.locator("#subtitle");
    await expect(subtitle).toContainText("3 sessions");
    await expect(subtitle).toContainText("1 live");
  });

  test("shows empty state when no sessions", async ({ page }) => {
    await mockGallery(page, []);
    await page.goto("/");
    await expect(page.locator(".empty")).toBeVisible();
    await expect(page.locator(".empty")).toContainText("No sessions found");
  });

  test("updates last-refresh timestamp", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#last-refresh")).not.toHaveText("--");
  });

  test("thumbnail image renders or shows placeholder", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator(".card");

    // First card has thumbnail
    const thumb = cards.first().locator("img.card-thumb");
    if (await thumb.count() > 0) {
      // Image exists — it may load or error (proxied), both are valid states
    }

    // Third card has no thumbnail — should show placeholder
    await expect(cards.last().locator(".card-thumb-placeholder")).toBeVisible();
  });
});

test.describe("Gallery filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(3);
  });

  test("All filter shows all sessions", async ({ page }) => {
    await page.locator('.filter-btn[data-filter="all"]').click();
    await expect(page.locator(".card")).toHaveCount(3);
  });

  test("Live filter shows only live sessions", async ({ page }) => {
    await page.locator('.filter-btn[data-filter="live"]').click();
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card").first().locator(".badge-live")).toBeVisible();
  });

  test("Recorded filter shows only recorded sessions", async ({ page }) => {
    await page.locator('.filter-btn[data-filter="recorded"]').click();
    await expect(page.locator(".card")).toHaveCount(2);
  });

  test("My Sessions filter shows only owned sessions", async ({ page }) => {
    await page.locator('.filter-btn[data-filter="mine"]').click();
    await expect(page.locator(".card")).toHaveCount(1);
  });

  test("active filter button has active class", async ({ page }) => {
    const liveBtn = page.locator('.filter-btn[data-filter="live"]');
    await liveBtn.click();
    await expect(liveBtn).toHaveClass(/active/);
    await expect(page.locator('.filter-btn[data-filter="all"]')).not.toHaveClass(/active/);
  });

  test("filter preserves subtitle showing total counts", async ({ page }) => {
    await page.locator('.filter-btn[data-filter="live"]').click();
    // Subtitle still shows total counts even when filtered
    const subtitle = page.locator("#subtitle");
    await expect(subtitle).toContainText("3 sessions");
  });
});

test.describe("Gallery card actions", () => {
  test("Play button opens recorded video player overlay", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(3);

    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);
  });

  test("closing video player returns to gallery", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-action="play"]').first().click();
    await expect(page.locator("#videoPlayer")).toHaveClass(/active/);

    await page.locator("#closeVideoBtn").click();
    await expect(page.locator("#videoPlayer")).not.toHaveClass(/active/);
    await expect(page.locator("#gallery")).toBeVisible();
  });

  test("Watch Live link points to /session/<id>", async ({ page }) => {
    await page.goto("/");
    const liveLink = page.locator('.card a:has-text("Watch Live")');
    await expect(liveLink).toHaveCount(1);
    const href = await liveLink.getAttribute("href");
    expect(href).toMatch(/\/session\/session-001/);
  });

  test("Share button opens share dialog (owner only)", async ({ page }) => {
    await page.goto("/");

    // First card is owner — has share button
    const shareBtns = page.locator('[data-action="share"]');
    await expect(shareBtns).toHaveCount(1);

    await shareBtns.first().click();
    await expect(page.locator("#shareDialog")).not.toHaveClass(/hidden/);
  });

  test("Download link opens in new tab with noopener", async ({ page }) => {
    await page.goto("/");
    const downloadLink = page.locator('.card a:has-text("Download")').first();
    expect(await downloadLink.getAttribute("target")).toBe("_blank");
    expect(await downloadLink.getAttribute("rel")).toBe("noopener");
  });
});

test.describe("Gallery error handling", () => {
  test("shows error when gallery fetch returns server error", async ({ page }) => {
    // Clear the fixture's route and set up error response
    await page.unroute("**/gallery/api");
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" }),
    );
    await page.goto("/");
    await expect(page.locator("#network-error")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#network-error")).toContainText("Server error 500");
  });

  test("shows error when gallery server unreachable", async ({ page }) => {
    await page.unroute("**/gallery/api");
    await page.route("**/gallery/api", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("#network-error")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#network-error")).toContainText("Network error");
  });
});
