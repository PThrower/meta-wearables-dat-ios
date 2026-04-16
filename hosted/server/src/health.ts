/**
 * health.ts — Health check logic
 *
 * - computeHealth(): pure sync, zero I/O
 * - probeHostedServices(): async, probes gateway + object store in parallel
 */

import type { ObjectStore } from "@ebowwa/object-store";
import type { HealthResponse, HostedSection, ServiceProbe } from "./health-types.js";

// --- Re-export types for convenience ---
export type { HealthResponse, HostedSection, ServiceProbe };

// --- Sync health ---

export interface HealthParams {
  serverStartTime: number;
  wasmLoaded: boolean;
}

export function computeHealth(params: HealthParams): HealthResponse {
  return {
    ok: true,
    uptimeMs: Date.now() - params.serverStartTime,
    wasmLoaded: params.wasmLoaded,
    timestamp: new Date().toISOString(),
    gitCommit: process.env.GIT_COMMIT?.slice(0, 7) ?? "unknown",
    buildVersion: process.env.BUILD_VERSION ?? "dev",
  };
}

// --- Async hosted probes ---

export interface ProbeParams {
  store: ObjectStore;
  serverStartTime: number;
  wasmLoaded: boolean;
}

const GATEWAY_URL = process.env.GATEWAY_HEALTH_URL || "http://127.0.0.1:3000/api/config";
const GATEWAY_TIMEOUT_MS = 3000;

async function probeGateway(): Promise<ServiceProbe> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GATEWAY_TIMEOUT_MS);
    const resp = await fetch(GATEWAY_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${resp.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: null, error: err?.code ?? err?.message ?? String(err) };
  }
}

async function probeObjectStore(store: ObjectStore): Promise<{ ok: boolean; type: "s3" | "memory"; endpoint: string | null; canary: ServiceProbe }> {
  // Detect store type via constructor name (S3Store vs MemoryStore)
  const ctorName = (store as any).constructor?.name ?? "";
  const isS3 = ctorName === "S3Store" || ctorName.includes("S3");
  const type: "s3" | "memory" = isS3 ? "s3" : "memory";
  const endpoint = isS3 ? (process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT ?? null) : null;

  // Canary: put → get → delete a tiny key
  const canaryKey = "__health_canary__";
  const canaryValue = Buffer.from(`ok:${Date.now()}`);
  const start = Date.now();

  try {
    await store.put(canaryKey, canaryValue);
    const retrieved = await store.get(canaryKey);
    await store.delete(canaryKey);

    const ok = retrieved != null;
    return {
      ok,
      type,
      endpoint,
      canary: {
        ok,
        latencyMs: Date.now() - start,
        error: ok ? undefined : "canary value mismatch",
      },
    };
  } catch (err: any) {
    // Best-effort cleanup
    try { await store.delete(canaryKey); } catch {}
    return {
      ok: false,
      type,
      endpoint,
      canary: {
        ok: false,
        latencyMs: Date.now() - start,
        error: err?.message ?? String(err),
      },
    };
  }
}

export async function probeHostedServices(params: ProbeParams): Promise<HostedSection> {
  const [gateway, objectStore] = await Promise.all([
    probeGateway(),
    probeObjectStore(params.store),
  ]);

  return {
    relay: {
      ok: true,
      uptimeMs: Date.now() - params.serverStartTime,
      wasmLoaded: params.wasmLoaded,
      memoryUsageMb: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100,
    },
    gateway,
    objectStore,
  };
}
