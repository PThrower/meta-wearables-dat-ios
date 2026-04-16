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
        clientIp: session.publisher.clientIp,
        deviceId: session.publisher.deviceId,
        deviceName: session.publisher.deviceName,
        deviceModel: session.publisher.deviceModel,
        systemVersion: session.publisher.systemVersion,
        wearableId: session.publisher.wearableId,
        wearableType: session.publisher.wearableType,
        appVersion: session.publisher.appVersion,
        buildNumber: session.publisher.buildNumber,
        frameCount: session.publisher.frameCount,
        totalBytes: session.publisher.totalBytes,
        totalMB: Math.round(session.publisher.totalBytes / 1048576 * 100) / 100,
        audioCount: session.publisher.audioCount,
        audioBytes: session.publisher.audioBytes,
        audioMB: Math.round(session.publisher.audioBytes / 1048576 * 100) / 100,
        audioTaps: Object.fromEntries(
          [...session.publisher.audioTaps.entries()].map(([ct, tap]) => [ct, {
            codecType: ct,
            label: ct === 0 ? "built-in mic" : ct === 1 ? "glasses HFP mic" : ct === 2 ? "TTS playback" : `unknown(${ct})`,
            frameCount: tap.count,
            bytes: tap.bytes,
            sampleRate: tap.sampleRate,
            lastAtMs: tap.lastAt,
          }])
        ),
        uptimeMs: pubUptimeMs,
        latencyMs: session.publisher.timing.lastReceivedAt > 0
          ? Math.round(now - session.publisher.timing.lastReceivedAt)
          : null,
        video: session.publisher.lastHeader,
        timing: formatTiming(session.publisher.timing),
      } : null,
      rates: { videoBitrateMbps, audioBitrateKbps, framesPerSecond },
      recording: session.recorder ? session.recorder.getStats() : { active: false },
      bucketUrl,
      viewers: session.viewers.size,
      viewerStats: Object.fromEntries(
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
    };
  }

  // Aggregate bandwidth
  let totalBytesIn = 0;
  let totalBytesOut = 0;
  for (const session of src.sessions.values()) {
    if (session.publisher) {
      totalBytesIn += session.publisher.totalBytes + session.publisher.audioBytes;
    }
    for (const viewer of session.viewers.values()) {
      totalBytesOut += viewer.totalBytes;
    }
  }

  const serverUptimeMs = now - serverStartTime;
  const serverUptimeSec = serverUptimeMs / 1000;
  const totalBandwidthMbps = serverUptimeSec > 0
    ? Math.round((totalBytesIn + totalBytesOut) / serverUptimeSec * 8 / 125000 * 100) / 100
    : 0;

  return {
    server: {
      uptimeMs: serverUptimeMs,
      wasmLoaded: src.wasmLoaded(),
      sessionCount: src.sessions.size,
      ip: wifiIp,
      port,
      memoryUsageMb: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100,
      activeConnections: activePublisherCount + src.totalViewers(),
      gitCommit: process.env.GIT_COMMIT?.slice(0, 7) ?? "unknown",
      buildVersion: process.env.BUILD_VERSION ?? "dev",
    },
    aggregate: {
      totalViewers: src.totalViewers(),
      peakViewers: src.peakViewers,
      totalBandwidthMbps,
      totalBytesInMB: Math.round(totalBytesIn / 1048576 * 100) / 100,
      totalBytesOutMB: Math.round(totalBytesOut / 1048576 * 100) / 100,
      totalFramesRelayed: src.totalFramesRelayed,
      totalDroppedFrames: src.totalDroppedFrames,
      sessionsStarted: src.sessionsStarted,
    },
    reliability: {
      viewersRejected: src.viewersRejected,
      publisherReconnects: src.publisherReconnects,
      framesThrottledWasm: src.framesThrottledWasm,
      framesThrottledQuality: src.framesThrottledQuality,
    },
    gallery: {
      note: "Use /gallery/api for historical gallery data",
    },
    audioTaps: audioTapCount,
    sessions,
  };
}
