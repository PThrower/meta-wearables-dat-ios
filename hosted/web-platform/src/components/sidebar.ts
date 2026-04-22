/**
 * Collapsible sidebar navigation — matches GlassFlow's nav structure.
 * Collapsed state persists to localStorage.
 */

import { routes, icons } from "../router/routes.js";
import { bus } from "../core/event-bus.js";

const STORAGE_KEY = "cm_sidebar_collapsed";

export function initSidebar(sidebar: HTMLElement, currentPath: string): () => void {
  const collapsed = localStorage.getItem(STORAGE_KEY) === "true";
  if (collapsed) sidebar.classList.add("collapsed");

  render(sidebar, currentPath);

  // Toggle button
  const toggle = sidebar.querySelector(".sidebar-toggle") as HTMLElement;
  toggle?.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    const now = sidebar.classList.contains("collapsed");
    localStorage.setItem(STORAGE_KEY, String(now));
    bus.emit("sidebar:toggle", { collapsed: now });
  });

  // Listen for route changes to update active state
  const off = bus.on("route:changed", ({ path }) => {
    updateActive(sidebar, path);
  });

  // Also handle direct hash changes (e.g., browser back/forward)
  const onHash = () => updateActive(sidebar, location.hash.slice(1) || "/");
  window.addEventListener("hashchange", onHash);

  return () => {
    off();
    window.removeEventListener("hashchange", onHash);
  };
}

function render(sidebar: HTMLElement, currentPath: string): void {
  sidebar.innerHTML = `
    <div class="sidebar-header">
      <span class="sidebar-logo">CM</span>
      <span class="sidebar-title">CaringMind</span>
      <button class="sidebar-toggle" title="Toggle sidebar">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
    </div>
    <nav class="sidebar-nav">
      ${routes.map((r) => navItem(r, currentPath)).join("")}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-status">
        <span class="status-dot"></span>
        <span class="sidebar-status-text">Online</span>
      </div>
    </div>
  `;

  // Bind navigation clicks
  sidebar.querySelectorAll<HTMLAnchorElement>(".sidebar-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const path = link.getAttribute("href")!.slice(1); // remove #
      location.hash = path;
    });
  });
}

function navItem(route: typeof routes[0], currentPath: string): string {
  const active = isActive(route.path, currentPath);
  return `
    <a href="#${route.path}" class="sidebar-link${active ? " active" : ""}" title="${route.title}">
      <span class="sidebar-icon">${icons[route.icon] || ""}</span>
      <span class="sidebar-label">${route.title}</span>
    </a>
  `;
}

function isActive(routePath: string, currentPath: string): boolean {
  if (routePath === "/") return currentPath === "/" || currentPath === "";
  return currentPath.startsWith(routePath);
}

function updateActive(sidebar: HTMLElement, path: string): void {
  sidebar.querySelectorAll(".sidebar-link").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    const routePath = href.slice(1); // remove #
    link.classList.toggle("active", isActive(routePath, path));
  });
}
