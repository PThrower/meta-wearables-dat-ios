/**
 * Audio tap endpoint tests -- TDD for /tap/audio WebSocket endpoint
 *
 * Contract:
 *   GET /tap/audio?session=<id>  -- WebSocket upgrade
 *   Tap clients receive JSON AudioFrame messages:
 *     { codecType, sequence, sampleRate, channels, bitsPerSample, timestampMs, pcmBase64 }
 *   Multiple tap clients can connect simultaneously
 *   Disconnect = no more frames
 */

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { buildFRAUFrame } from "./helpers.js";

describe("Audio tap WebSocket endpoint", () => {
  const PORT = 18923;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let audioTapBus: any;

  beforeAll(async () => {
    const { AudioTapBus } = await import("../src/audio-tap.js");
    audioTapBus = new AudioTapBus();

    server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch(req, s) {
        const url = new URL(req.url);

        if (url.pathname === "/tap/audio") {
          const sessionId = url.searchParams.get("session") || "default";
          return s.upgrade(req, { data: { type: "audio-tap", sessionId } });
        }

        if (url.pathname === "/test/inject-audio" && req.method === "POST") {
          return req.arrayBuffer().then(async (buf) => {
            audioTapBus.publish(new Uint8Array(buf));
            return Response.json({ ok: true, taps: audioTapBus.tapCount() });
          });
        }

        if (url.pathname === "/test/tap-count") {
          return Response.json({ count: audioTapBus.tapCount() });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
      websocket: {
        open(ws) {
          const unsub = audioTapBus.onFrame((frame: any) => {
            if (ws.readyState !== WebSocket.OPEN) { unsub(); return; }
            ws.send(JSON.stringify({
              type: "audio",
              codecType: frame.codecType,
              sequence: frame.sequence,
              sampleRate: frame.sampleRate,
              channels: frame.channels,
              bitsPerSample: frame.bitsPerSample,
              timestampMs: frame.timestampMs,
              pcmBase64: Buffer.from(frame.pcm).toString("base64"),
            }));
          });
          ws.data = { ...ws.data, unsub };
        },
        close(ws) {
          if (ws.data.unsub) ws.data.unsub();
        },
        message() {},
      },
    });
  });

  afterAll(() => {
    server?.stop();
  });

  test("tap client receives JSON audio frames", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/tap/audio?session=test");
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // Listen BEFORE inject
    const msgPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
      ws.onerror = (e) => { clearTimeout(t); reject(e); };
    });

    // Inject
    const frame = buildFRAUFrame({
      codecType: 0,
      sequence: 42,
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      timestampMs: 1700000000123,
      pcmPayload: new Uint8Array(128),
    });
    await fetch("http://127.0.0.1:" + PORT + "/test/inject-audio", { method: "POST", body: frame });

    const msg = await msgPromise;
    expect(msg.type).toBe("audio");
    expect(msg.sequence).toBe(42);
    expect(msg.sampleRate).toBe(8000);
    expect(msg.channels).toBe(1);
    expect(msg.timestampMs).toBe(1700000000123);
    const pcm = Buffer.from(msg.pcmBase64, "base64");
    expect(pcm.length).toBe(128);
    ws.close();
  });

  test("multiple tap clients receive same frames", async () => {
    const ws1 = new WebSocket("ws://127.0.0.1:" + PORT + "/tap/audio?session=test");
    const ws2 = new WebSocket("ws://127.0.0.1:" + PORT + "/tap/audio?session=test");
    await Promise.all([
      new Promise<void>((r) => { ws1.onopen = () => r(); }),
      new Promise<void>((r) => { ws2.onopen = () => r(); }),
    ]);

    // Listen BEFORE inject
    const p1 = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("t1 timeout")), 3000);
      ws1.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
    });
    const p2 = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("t2 timeout")), 3000);
      ws2.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
    });

    const frame = buildFRAUFrame({ sequence: 1, sampleRate: 48000, channels: 1, pcmPayload: new Uint8Array(256) });
    await fetch("http://127.0.0.1:" + PORT + "/test/inject-audio", { method: "POST", body: frame });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.sampleRate).toBe(48000);
    expect(m2.sampleRate).toBe(48000);
    ws1.close();
    ws2.close();
  });

  test("disconnected tap stops receiving frames", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/tap/audio?session=test");
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.close();
    await new Promise<void>((r) => setTimeout(r, 100));

    const frame = buildFRAUFrame({ sampleRate: 16000, pcmPayload: new Uint8Array(64) });
    const resp = await fetch("http://127.0.0.1:" + PORT + "/test/inject-audio", { method: "POST", body: frame });
    expect(resp.status).toBe(200);
  });

  test("tap receives sequential frames in order", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/tap/audio?session=test");
    await new Promise<void>((r) => { ws.onopen = () => r(); });

    for (let i = 0; i < 10; i++) {
      // Listen BEFORE inject
      const msgP = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout at " + i)), 3000);
        ws.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
      });

      const frame = buildFRAUFrame({ sequence: i, sampleRate: 48000, pcmPayload: new Uint8Array(64) });
      await fetch("http://127.0.0.1:" + PORT + "/test/inject-audio", { method: "POST", body: frame });

      const msg = await msgP;
      expect(msg.sequence).toBe(i);
    }
    ws.close();
  });
});
