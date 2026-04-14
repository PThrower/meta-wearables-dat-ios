/**
 * e2e helpers — shared fixtures, mock data, WS helpers
 */

import { test as base, expect, type Page, type Route } from "@playwright/test";

// --- Mock data ---

export const MOCK_CONFIG = {
  googleClientId: "test-client-id.apps.googleusercontent.com",
  noAuth: true,
  version: { gitCommit: "abc1234", buildVersion: "0.1.0" },
};

export const MOCK_GALLERY_SESSIONS = [
  {
    sessionId: "session-001-aaaaaaaa",
    live: true,
    durationMs: 45000,
    startedAt: new Date().toISOString(),
    segments: 12,
    audioChunks: 8,
    exportCached: false,
    hasThumbnail: true,
    thumbnailUrl: "/session/session-001-aaaaaaaa/thumb",
    videoUrl: "/session/session-001-aaaaaaaa/video",
    device: { deviceName: "Meta Ray-Ban", deviceModel: "Wayfarer", wearableType: "glasses" },
    ownerId: "user-1",
    ownerEmail: "owner@example.com",
    accessLevel: "public" as const,
    viewerRole: "owner" as const,
  },
  {
    sessionId: "session-002-bbbbbbbb",
    live: false,
    durationMs: 120000,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    segments: 30,
    audioChunks: 25,
    exportCached: true,
    hasThumbnail: true,
    thumbnailUrl: "/session/session-002-bbbbbbbb/thumb",
    videoUrl: "/session/session-002-bbbbbbbb/video",
    device: { deviceName: "Meta Ray-Ban", wearableType: "glasses" },
    ownerId: "user-2",
    ownerEmail: "viewer@example.com",
    accessLevel: "link" as const,
    viewerRole: "viewer" as const,
  },
  {
    sessionId: "session-003-cccccccc",
    live: false,
    durationMs: 0,
    startedAt: new Date(Date.now() - 7200_000).toISOString(),
    segments: 0,
    audioChunks: 0,
    exportCached: false,
    hasThumbnail: false,
    videoUrl: undefined,
    device: {},
    accessLevel: "private" as const,
    viewerRole: "none" as const,
  },
];

// --- Route interception helpers ---

export async function mockConfig(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.route("**/api/config", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...MOCK_CONFIG, ...overrides }) }),
  );
}

export async function mockGallery(page: Page, sessions = MOCK_GALLERY_SESSIONS): Promise<void> {
  await page.route("**/gallery/api", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessions) }),
  );
}

// --- Custom test fixture with mocked config ---

export const test = base.extend({
  page: async ({ page }, use) => {
    await mockConfig(page);
    await mockGallery(page);
    await use(page);
  },
});

export { expect };
