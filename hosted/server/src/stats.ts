/**
 * stats.ts — Platform-wide and per-session live stats
 *
 * Computes stats from in-memory session state only.
 * Historical gallery data lives at /gallery/api.
 */

import type { ObjectStore } from "@ebowwa/object-store";
import type { Session } from "./types.js";
import { QUALITY_PRESETS } from "./types.js";
import { formatTiming } from "./protocol.js";
import { probeHostedServices } from "./health.js";

/** Shape the registry must expose for stats computation */
export interface StatsSource {
  sessions: Map<string, Session>;
  store: ObjectStore;
  wasmLoaded(): boolean;
  totalViewers(): number;
  peakViewers: number;
  totalFramesRelayed: number;
  totalDroppedFrames: number;
  sessionsStarted: number;
  viewersRejected: number;
  publisherReconnects: number;
  framesThrottledWasm: number;
  framesThrottledQuality: number;
}

export interface StatsParams {
  wifiIp: string;
  port: number;
  serverStartTime: number;
  audioTapCount: number;
}

export async function computeStats(src: StatsSource, params: StatsParams) {
  const { wifiIp, port, serverStartTime, audioTapCount } = params;
  const now = Date.now();
  const sessions: Record<string, any> = {};
  let activePublisherCount = 0;

  for (const [id, session] of src.sessions) {
    let bucketUrl: string | null = null;
    if (session.recorder && session.publisher) {
      try {
        bucketUrl = await src.store.signedUrl(`sessions/${session.recordingId}/meta.json`, 3600);
      } catch { bucketUrl = null; }
    }

    if (session.publisher) activePublisherCount++;

    const pubUptimeMs = session.publisher ? now - session.publisher.connected : 0;
    const videoBitrateMbps = session.publisher && pubUptimeMs > 0
      ? Math.round(session.publisher.totalBytes / pubUptimeMs * 1000 / 125000 * 100) / 100
      : 0;
    const audioBitrateKbps = session.publisher && pubUptimeMs > 0
      ? Math.round(session.publisher.audioBytes / pubUptimeMs * 1000 / 125 * 100) / 100
      : 0;
    const framesPerSecond = session.publisher && pubUptimeMs > 1000
      ? Math.round(session.publisher.frameCount / (pubUptimeMs / 1000) * 10) / 10
      : 0;

    sessions[id] = {
      publisher: session.publisher ? {
        id: session.publisher.id,
        connection: {
          clientIp: session.publisher.clientIp,
          uptimeMs: pubUptimeMs,
          wireLatencyMs: session.publisher.timing.lastReceivedAt > 0
            ? Math.round(now - session.publisher.timing.lastReceivedAt)
            : null,
          timing: formatTiming(session.publisher.timing),
        },
        device: {
          id: session.publisher.deviceId,
          name: session.publisher.deviceName,
          model: session.publisher.deviceModel,
          systemVersion: session.publisher.systemVersion,
        },
        wearable: {
          id: session.publisher.wearableId,
          type: session.publisher.wearableType,
        },
        app: {
          version: session.publisher.appVersion,
          buildNumber: session.publisher.buildNumber,
        },
        video: {
          frames: session.publisher.frameCount,
          bytes: session.publisher.totalBytes,
          mb: Math.round(session.publisher.totalBytes / 1048576 * 100) / 100,
          lastHeader: session.publisher.lastHeader,
        },
        audio: {
          frames: session.publisher.audioCount,
          bytes: session.publisher.audioBytes,
          mb: Math.round(session.publisher.audioBytes / 1048576 * 100) / 100,
          taps: Object.fromEntries(
            [...session.publisher.audioTaps.entries()].map(([ct, tap]) => [ct, {
              codecType: ct,
              label: ct === 0 ? "built-in mic" : ct === 1 ? "glasses HFP mic" : ct === 2 ? "TTS playback" : `unknown(${ct})`,
              frameCount: tap.count,
              bytes: tap.bytes,
              sampleRate: tap.sampleRate,
              lastAtMs: tap.lastAt,
            }])
          ),
        },
        rates: { videoMbps: videoBitrateMbps, audioKbps: audioBitrateKbps, fps: framesPerSecond },
      } : null,
      viewerCount: session.viewers.size,
      viewers: Object.fromEntries(
        [...session.viewers.entries()].map(([vid, v]) => [vid.slice(0, 8), {
          clientIp: v.clientIp,
          quality: v.quality,
          maxFps: QUALITY_PRESETS[v.quality].maxFps,
          frames: v.frameCount,
          throttled: v.throttledCount,
          totalBytes: v.totalBytes,
          totalMB: Math.round(v.totalBytes / 1048576 * 100) / 100,
          uptimeMs: now - v.connected,
          timing: formatTiming(v.timing),
          gitCommit: v.gitCommit,
          buildVersion: v.buildVersion,
        }])
      ),
      recording: session.recorder ? session.recorder.getStats() : { active: false },
      bucketUrl,
    };
  }

  // Aggregate bandwidth
  let publisherBytesIn = 0;
  let viewerBytesOut = 0;
  for (const session of src.sessions.values()) {
    if (session.publisher) {
      publisherBytesIn += session.publisher.totalBytes + session.publisher.audioBytes;
    }
    for (const viewer of session.viewers.values()) {
      viewerBytesOut += viewer.totalBytes;
    }
  }

  const serverUptimeMs = now - serverStartTime;
  const serverUptimeSec = serverUptimeMs / 1000;
  const totalBandwidthMbps = serverUptimeSec > 0
    ? Math.round((publisherBytesIn + viewerBytesOut) / serverUptimeSec * 8 / 125000 * 100) / 100
    : 0;

  return {
    server: {
      uptimeMs: serverUptimeMs,
      gitCommit: process.env.GIT_COMMIT?.slice(0, 7) ?? "unknown",
      buildVersion: process.env.BUILD_VERSION ?? "dev",
      ip: wifiIp,
      port,
      memoryUsageMb: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100,
      hosted: {
        relay: {
          wasmLoaded: src.wasmLoaded(),
          sessions: {
            active: src.sessions.size,
            started: src.sessionsStarted,
          },
          connections: {
            publishers: activePublisherCount,
            viewers: src.totalViewers(),
            total: activePublisherCount + src.totalViewers(),
          },
        },
        ...(await probeHostedServices({ store: src.store, serverStartTime, wasmLoaded: src.wasmLoaded() })),
      },
      metrics: {
        aggregate: {
          viewers: {
            peak: src.peakViewers,
          },
          bandwidth: {
            publisherInMB: Math.round(publisherBytesIn / 1048576 * 100) / 100,
            viewerOutMB: Math.round(viewerBytesOut / 1048576 * 100) / 100,
            totalMbps: totalBandwidthMbps,
          },
          frames: {
            relayed: src.totalFramesRelayed,
            dropped: src.totalDroppedFrames,
          },
        },
        reliability: {
          viewersRejected: src.viewersRejected,
          publisherReconnects: src.publisherReconnects,
          throttled: {
            wasm: src.framesThrottledWasm,
            quality: src.framesThrottledQuality,
          },
        },
        audioTaps: audioTapCount,
        sessions,
      },
    },
  };
}
