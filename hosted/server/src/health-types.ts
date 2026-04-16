/**
 * health-types.ts — Types for /health endpoint and hosted service probes
 */

export interface HealthResponse {
  ok: true;
  uptimeMs: number;
  wasmLoaded: boolean;
  timestamp: string;
  gitCommit: string;
  buildVersion: string;
}

export interface ServiceProbe {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface AIProviderEntry {
  provider: string;
  activeSessions: number;
  recentErrors: Array<{ message: string; at: string }>;
}

export interface HostedSection {
  relay: { ok: true; uptimeMs: number; wasmLoaded: boolean; memoryUsageMb: number };
  gateway: ServiceProbe;
  objectStore: ServiceProbe;
  aiProviders: AIProviderEntry[];
}
