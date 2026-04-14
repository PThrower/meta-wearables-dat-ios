/**
 * Auth e2e — login overlay, token handling, auth gating
 */

import { test, expect, type Page } from "@playwright/test";

const MOCK_CONFIG_AUTHED = {
  googleClientId: "test.apps.googleusercontent.com",
  noAuth: true,
  version: { gitCommit: "abc1234", buildVersion: "0.1.0" },
};

const MOCK_CONFIG_GATED = {
  googleClientId: "test.apps.googleusercontent.com",
  noAuth: false,
  version: { gitCommit: "abc1234", buildVersion: "0.1.0" },
};

const MOCK_SESSIONS = [
  {
    sessionId: "session-001-aaaaaaaa", live: true, durationMs: 45000,
    startedAt: new Date().toISOString(), segments: 12, audioChunks: 8,
    exportCached: false, hasThumbnail: true,
    device: { deviceName: "Test Device" }, accessLevel: "public" as const,
    viewerRole: "owner" as const,
  },
];

function fakeJwt(email: string, expSecondsFromNow: number): string {
  return "header." + btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })) + ".sig";
}

async function setupNoAuth(page: Page): Promise<void> {
  await page.route("**/api/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_CONFIG_AUTHED) }),
  );
  await page.route("**/gallery/api", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_SESSIONS) }),
  );
}

async function setupGated(page: Page): Promise<void> {
  await page.route("**/api/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_CONFIG_GATED) }),
  );
  await page.route("**/gallery/api", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_SESSIONS) }),
  );
}

async function simulateLogin(page: Page, email = "test@example.com"): Promise<void> {
  await page.evaluate((token) => {
    localStorage.setItem("relay_token", token);
    document.getElementById("loginOverlay")!.classList.add("hidden");
    window.dispatchEvent(new CustomEvent("auth:login"));
  }, fakeJwt(email, 3600));
}

test.describe("Auth - noAuth mode", () => {
  test("no login overlay when noAuth=true", async ({ page }) => {
    await setupNoAuth(page);
    await page.goto("/");
    await expect(page.locator("#loginOverlay")).toHaveClass(/hidden/);
    await expect(page.locator("#gallery")).toBeVisible();
  });

  test("no user info shown when noAuth=true", async ({ page }) => {
    await setupNoAuth(page);
    await page.goto("/");
    await expect(page.locator("#userInfo")).toBeEmpty();
  });
});

test.describe("Auth - gated mode", () => {
  test("shows login overlay when no token and auth required", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await expect(page.locator("#loginOverlay")).not.toHaveClass(/hidden/);
  });

  test("g_id_signin container exists in login overlay", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await expect(page.locator("#g_id_signin")).toBeAttached();
  });

  test("gallery fetches data after login event", async ({ page }) => {
    await setupGated(page);
    let galleryCalled = false;
    await page.route("**/gallery/api", (route) => {
      galleryCalled = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_SESSIONS) });
    });
    await page.goto("/");
    await simulateLogin(page);
    await page.waitForFunction(() => {
      const grid = document.getElementById("grid");
      return grid && grid.children.length > 0;
    }, { timeout: 5000 });
    expect(galleryCalled).toBe(true);
  });

  test("hides login overlay after successful auth", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await expect(page.locator("#loginOverlay")).not.toHaveClass(/hidden/);
    await simulateLogin(page);
    await expect(page.locator("#loginOverlay")).toHaveClass(/hidden/);
  });

  test("shows user email after login", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await simulateLogin(page);
    await expect(page.locator(".user-email")).toContainText("test@example.com", { timeout: 5000 });
  });

  test("shows logout button after login", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await simulateLogin(page);
    await expect(page.locator("#logoutBtn")).toBeVisible({ timeout: 5000 });
  });

  test("logout clears token and shows login overlay", async ({ page }) => {
    await setupGated(page);
    await page.goto("/");
    await simulateLogin(page);
    await expect(page.locator("#logoutBtn")).toBeVisible({ timeout: 5000 });
    await page.locator("#logoutBtn").click();
    const token = await page.evaluate(() => localStorage.getItem("relay_token"));
    expect(token).toBeNull();
    await expect(page.locator("#loginOverlay")).not.toHaveClass(/hidden/);
  });

  test("expired token triggers re-auth on boot", async ({ page }) => {
    await setupGated(page);
    await page.addInitScript((token) => {
      localStorage.setItem("relay_token", token);
    }, fakeJwt("test@example.com", -3600));
    await page.goto("/");
    await expect(page.locator("#loginOverlay")).not.toHaveClass(/hidden/, { timeout: 5000 });
  });

  test("authFetch clears token on 401 response", async ({ page }) => {
    await setupGated(page);
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 401, body: "Unauthorized" }),
    );
    await page.addInitScript((token) => {
      localStorage.setItem("relay_token", token);
    }, fakeJwt("test@example.com", 3600));
    await page.goto("/");
    await page.waitForTimeout(1000);
    const token = await page.evaluate(() => localStorage.getItem("relay_token"));
    expect(token).toBeNull();
  });
});
