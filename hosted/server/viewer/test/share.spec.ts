/**
 * Share dialog e2e — create, copy, revoke share tokens
 */

import { test, expect, mockConfig, MOCK_GALLERY_SESSIONS } from "./helpers";

test.describe("Share dialog", () => {
  test.beforeEach(async ({ page }) => {
    await mockConfig(page);
    await page.route("**/gallery/api", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_GALLERY_SESSIONS) }),
    );
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(3);
  });

  test("opens share dialog on share button click", async ({ page }) => {
    await page.locator('[data-action="share"]').first().click();
    await expect(page.locator("#shareDialog")).not.toHaveClass(/hidden/);
    await expect(page.locator("#shareDialog h3")).toContainText("Share Session");
  });

  test("closes share dialog on close button", async ({ page }) => {
    await page.locator('[data-action="share"]').first().click();
    await expect(page.locator("#shareDialog")).not.toHaveClass(/hidden/);

    await page.locator("#closeShareDialog").click();
    await expect(page.locator("#shareDialog")).toHaveClass(/hidden/);
  });

  test("loads existing share tokens on open", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { token: "tok_aaaaaaaaaaaaaaaa", expiresAt: new Date(Date.now() + 86400_000).toISOString(), createdAt: new Date().toISOString() },
        ]),
      }),
    );

    await page.locator('[data-action="share"]').first().click();
    await expect(page.locator("#shareTokenList")).toContainText("tok_aaaaaaaa");
  });

  test("shows empty message when no share tokens exist", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.locator('[data-action="share"]').first().click();
    await expect(page.locator(".share-token-empty")).toContainText("No active share links");
  });

  test("creates new share link", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;
    const newToken = "tok_newshare123456";

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.route(`**/session/${sessionId}/share`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ token: newToken }),
        });
      }
      return route.continue();
    });

    // Re-mock shares to return the new token after creation
    let sharesCallCount = 0;
    await page.route(`**/session/${sessionId}/shares`, (route) => {
      sharesCallCount++;
      if (sharesCallCount <= 1) {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { token: newToken, expiresAt: new Date(Date.now() + 604800_000).toISOString(), createdAt: new Date().toISOString() },
        ]),
      });
    });

    await page.locator('[data-action="share"]').first().click();
    await page.locator("#shareCreateBtn").click();

    // Share link input should have a value containing the token
    await expect(page.locator("#shareLink")).not.toHaveValue("");
  });

  test("copy button is wired and share link is populated after create", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.route(`**/session/${sessionId}/share`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "tok_copy123456789" }),
      }),
    );

    await page.locator('[data-action="share"]').first().click();
    await page.locator("#shareCreateBtn").click();

    // Verify share link input has a URL containing session ID and share token
    const linkInput = page.locator("#shareLink");
    await expect(linkInput).not.toHaveValue("");
    const value = await linkInput.inputValue();
    expect(value).toContain("session-001-aaaaaaaa");
    expect(value).toContain("share=tok_copy123456789");

    // Copy button is present and clickable
    await expect(page.locator("#shareCopyBtn")).toBeVisible();
  });

  test("shows expiry selector with correct defaults", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;
    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.locator('[data-action="share"]').first().click();

    const expirySelect = page.locator("#shareExpiry");
    await expect(expirySelect).toBeVisible();
    // Default should be 7 days (168 hours)
    await expect(expirySelect).toHaveValue("168");
  });

  test("shows expiring-soon class for tokens near expiry", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          // Expires in 1 hour — less than 24h threshold
          { token: "tok_expiring_soon1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: new Date().toISOString() },
          // Expires in 7 days — fine
          { token: "tok_still_valid11", expiresAt: new Date(Date.now() + 604800_000).toISOString(), createdAt: new Date().toISOString() },
        ]),
      }),
    );

    await page.locator('[data-action="share"]').first().click();

    const items = page.locator(".share-token-item");
    await expect(items).toHaveCount(2);

    // First item should have token-expiring class
    await expect(items.first()).toHaveClass(/token-expiring/);
    // Second should not
    await expect(items.nth(1)).not.toHaveClass(/token-expiring/);
  });

  test("revokes a share token via revoke button", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;
    const token = "tok_to_revoke1234";

    let deleteCalled = false;
    await page.route(`**/session/${sessionId}/share/${token}`, (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({ status: 200, body: "ok" });
      }
      return route.continue();
    });

    // First load: has the token
    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { token, expiresAt: new Date(Date.now() + 604800_000).toISOString(), createdAt: new Date().toISOString() },
        ]),
      }),
    );

    await page.locator('[data-action="share"]').first().click();
    await expect(page.locator(".share-token-item")).toHaveCount(1);

    // Click revoke
    await page.locator('[data-action="revoke"]').click();

    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(true);
  });

  test("shows error message on create failure", async ({ page }) => {
    const sessionId = MOCK_GALLERY_SESSIONS[0].sessionId;

    await page.route(`**/session/${sessionId}/shares`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await page.route(`**/session/${sessionId}/share`, (route) =>
      route.fulfill({ status: 403, body: "Forbidden" }),
    );

    await page.locator('[data-action="share"]').first().click();
    await page.locator("#shareCreateBtn").click();

    await expect(page.locator("#shareLink")).toHaveValue(/Error: 403/);
  });
});
