/**
 * Live player e2e — navigation, quality controls, audio UI, URL detection
 *
 * NOTE: The live player requires a WebSocket connection to the relay server.
 * Since the relay server is not running in e2e tests, the WS will fail,
 * but the player UI still renders. Tests verify the UI state, not the
 * actual streaming — that requires an integration test with a real server.
 */

import { test, expect, mockConfig, MOCK_GALLERY_SESSIONS } from "./helpers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Intercept /session/* paths to serve the index.html (the vite proxy would
 * forward these to the backend which isn't running in test).
 */
async function gotoSession(page: import("@playwright/test").Page, path: string): Promise<void> {
  await mockConfig(page);
  await page.route("**/gallery/api", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_GALLERY_SESSIONS) }),
  );

  // Serve index.html for any /session/* path — the JS boot code reads
  // location.pathname to extract the session ID
  const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf-8");
  await page.route("**/session/**", (route) => {
    // Only intercept the page navigation (not API calls under /session/)
    if (route.request().resourceType() === "document") {
      return route.fulfill({ status: 200, contentType: "text/html", body: indexHtml });
    }
    return route.continue();
  });

  await page.goto(path);
}

test.describe("Live player - navigation", () => {
  test("navigating to /session/<id> opens live player", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");

    await expect(page.locator("#gallery")).toHaveClass(/hidden/);
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);
  });

  test("back button returns to gallery from live player", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);

    await page.locator("#backBtn").click();
    await expect(page.locator("#livePlayer")).not.toHaveClass(/active/);
    await expect(page.locator("#gallery")).not.toHaveClass(/hidden/);
  });

  test("stats panel shows initial -- values", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");

    await expect(page.locator("#p-fps")).toHaveText("--");
    await expect(page.locator("#p-size")).toHaveText("--");
    await expect(page.locator("#p-latency")).toHaveText("--");
    await expect(page.locator("#p-drop")).toHaveText("--");
    await expect(page.locator("#p-audio")).toHaveText("OFF");
  });
});

test.describe("Live player - quality controls", () => {
  test("quality select dropdown has correct options", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");

    const select = page.locator("#quality-select");
    await expect(select).toBeVisible();
    const options = select.locator("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText("High (30 FPS)");
    await expect(options.nth(1)).toHaveText("Medium (15 FPS)");
    await expect(options.nth(2)).toHaveText("Low (8 FPS)");
    await expect(options.nth(3)).toHaveText("Mini (4 FPS)");
  });
});

test.describe("Live player - audio UI", () => {
  test("unmute overlay not shown initially", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#unmute")).not.toHaveClass(/show/);
  });

  test("PTT button is present in player controls", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#ptt-btn")).toBeVisible();
  });

  test("audio meter fill element exists", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#audio-meter-fill")).toBeAttached();
  });

  test("canvas element exists for rendering", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#liveCanvas")).toBeVisible();
  });
});

test.describe("Live player - URL session detection", () => {
  test("detects session from /session/<id> path", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);
  });

  test("detects session from ?session=<id> query param", async ({ page }) => {
    await mockConfig(page);
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_GALLERY_SESSIONS) }),
    );
    await page.goto("/?session=session-001-aaaaaaaa");
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);
  });

  test("detects share token from ?share=<token> query param", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa?share=share_tok_123");
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);
  });

  test("back button returns to gallery after direct session URL", async ({ page }) => {
    await gotoSession(page, "/session/session-001-aaaaaaaa");
    await expect(page.locator("#livePlayer")).toHaveClass(/active/);

    await page.locator("#backBtn").click();

    // Gallery visible, live player hidden
    await expect(page.locator("#gallery")).not.toHaveClass(/hidden/);
    await expect(page.locator("#livePlayer")).not.toHaveClass(/active/);
  });
});
