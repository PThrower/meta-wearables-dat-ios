/**
 * Route definitions with lazy-loaded page modules.
 * Add new pages here — the router handles the rest.
 */

import type { RouteConfig } from "./router.js";

export const routes: RouteConfig[] = [
  {
    path: "/",
    title: "Command Center",
    icon: "grid",
    load: () => import("../pages/dashboard.js").then(m => m.page),
  },
  {
    path: "/devices",
    title: "Fleet",
    icon: "devices",
    load: () => import("../pages/devices.js").then(m => m.page),
  },
  {
    path: "/live",
    title: "Live Streams",
    icon: "video",
    load: () => import("../pages/live-gallery.js").then(m => m.page),
  },
  {
    path: "/feeds",
    title: "Feeds",
    icon: "recordings",
    load: () => import("../pages/feeds.js").then(m => m.page),
  },
  {
    path: "/analytics",
    title: "Analytics",
    icon: "chart",
    load: () => import("../pages/analytics.js").then(m => m.page),
  },
  {
    path: "/workflows",
    title: "Workflows",
    icon: "workflow",
    load: () => import("../pages/workflow-editor.js").then(m => m.page),
  },
];

/** Icon SVG paths for sidebar nav items */
export const icons: Record<string, string> = {
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  devices: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  recordings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  workflow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><line x1="8.5" y1="6" x2="15.5" y2="6"/><path d="M6 8.5 L12 15.5"/><path d="M18 8.5 L12 15.5"/></svg>`,
};
