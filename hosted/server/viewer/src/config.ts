/**
 * Runtime config — fetched from /api/config on startup.
 * Replaces all window.__* globals injected by the server.
 */

export interface ViewerConfig {
  googleClientId: string;
  noAuth: boolean;
  version: { gitCommit: string; buildVersion: string };
}

let config: ViewerConfig | null = null;

export async function loadConfig(): Promise<ViewerConfig> {
  if (config) return config;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  config = (await res.json()) as ViewerConfig;
  return config;
}

export function getConfig(): ViewerConfig {
  if (!config) throw new Error("config not loaded — call loadConfig() first");
  return config;
}
