/**
 * Hash-based SPA router with page lifecycle management.
 * Uses #/path format — no server fallback config needed.
 */

export interface PageModule {
  init(container: HTMLElement): void;
  destroy(): void;
}

export interface RouteConfig {
  path: string;
  load: () => Promise<PageModule>;
  title: string;
  icon: string;
}

export class Router {
  private routes: RouteConfig[] = [];
  private currentPage: PageModule | null = null;
  private currentPath: string | null = null;
  private container: HTMLElement;
  private onNavigate?: (path: string) => void;

  constructor(container: HTMLElement, onNavigate?: (path: string) => void) {
    this.container = container;
    this.onNavigate = onNavigate;
    window.addEventListener("hashchange", () => this.onHashChange());
  }

  addRoutes(routes: RouteConfig[]): void {
    this.routes.push(...routes);
  }

  start(): void {
    const hash = location.hash.slice(1) || "/";
    this.navigate(hash);
  }

  navigate(path: string): void {
    // Normalize path
    if (!path.startsWith("/")) path = "/" + path;
    location.hash = path;
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }

  destroy(): void {
    window.removeEventListener("hashchange", () => this.onHashChange());
    if (this.currentPage) {
      this.currentPage.destroy();
      this.currentPage = null;
    }
  }

  private async onHashChange(): Promise<void> {
    const path = location.hash.slice(1) || "/";

    // Avoid re-navigating to the same route
    if (path === this.currentPath) return;

    // Skip "/" (gallery) and "/play/*" (recorded player) — handled externally
    if (path === "/" || path === "") {
      this.currentPath = "/";
      return;
    }
    if (path.startsWith("/play/")) {
      return;
    }

    // Find matching route (exact match first, then prefix)
    const route = this.findRoute(path);
    if (!route) {
      console.warn(`[router] no route for "${path}", falling back to /`);
      if (path !== "/") {
        location.hash = "/";
      }
      return;
    }

    // Destroy current page
    if (this.currentPage) {
      try {
        this.currentPage.destroy();
      } catch (err) {
        console.error("[router] destroy error:", err);
      }
      this.currentPage = null;
    }

    // Clear container
    this.container.innerHTML = "";

    // Load new page
    try {
      const page = await route.load();
      this.currentPage = page;
      this.currentPath = path;
      page.init(this.container);
      document.title = `${route.title} — CaringMind`;
      this.onNavigate?.(path);
    } catch (err) {
      console.error(`[router] failed to load page "${path}":`, err);
      this.container.innerHTML = `<div class="page-error"><p>Failed to load page.</p></div>`;
    }
  }

  private findRoute(path: string): RouteConfig | undefined {
    // Exact match
    let route = this.routes.find((r) => r.path === path);
    if (route) return route;

    // Prefix match (e.g., /devices/123 matches /devices)
    const prefix = "/" + path.split("/")[1];
    return this.routes.find((r) => r.path === prefix);
  }
}
