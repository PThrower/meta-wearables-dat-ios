/**
 * Bun WebSocket relay server for DAT SDK video frames.
 * Publisher (iOS app) sends FRLY-encoded JPEG frames to /publish
 * Viewers (browser) connect to / to receive decoded frames
 * Stats at /stats
 *
 * Wire protocol: [4B "FRLY"][8B seq][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

const PORT = 8080;

const publishers = new Map<string, WebSocket>();
const viewers = new Set<WebSocket>();
let frameCount = 0;
let lastFrameTime = 0;

const VIEWER_HTML = `<!DOCTYPE html>
<html><head><title>DAT Stream Viewer</title>
<style>
* { margin: 0; }
body { background: #000; display: flex; flex-direction: column; align-items: center; height: 100vh; }
canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
#hud { position: fixed; top: 8px; left: 8px; color: #0f0; font: 12px monospace; display: flex; gap: 12px; }
</style></head>
<body>
<canvas id="c"></canvas>
<div id="hud"><span>Connecting...</span></div>
<script>
const c = document.getElementById("c");
const ctx = c.getContext("2d");
const hud = document.getElementById("hud");
let ws, fps = 0, drops = 0, lastT = 0, frames = [];

function readU32LE(d, o) { return d[o] | (d[o+1] << 8) | (d[o+2] << 16) | (d[o+3] << 24); }
function readU64LE(d, o) {
  return d[o] | (d[o+1] << 8) | (d[o+2] << 16) | (d[o+3] << 24) |
    (d[o+4] * 0x100000000) | (d[o+5] * 0x1000000000000) |
    (d[o+6] * 0x100000000000000) | (d[o+7] * 0x10000000000000000);
}

function connect() {
  ws = new WebSocket("ws://" + location.host + "/publish");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { hud.innerHTML = "<span>CONNECTED</span>"; };
  ws.onmessage = (e) => {
    const d = new Uint8Array(e.data);
    if (d.length < 29) return;
    const magic = String.fromCharCode(d[0], d[1], d[2], d[3]);
    if (magic !== "FRLY") { drops++; return; }
    const seq = readU64LE(d, 4);
    const w = readU32LE(d, 12);
    const h = readU32LE(d, 16);
    const quality = d[20];
    const ts = readU64LE(d, 21);
    const jpeg = d.slice(29);
    const now = performance.now();
    frames.push(now);
    frames = frames.filter(t => t > now - 1000);
    fps = frames.length;
    const blob = new Blob([jpeg], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      c.width = img.width; c.height = img.height;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    const lat = Date.now() - Number(ts);
    hud.innerHTML =
      "<span>FPS:" + fps + "</span>" +
      "<span>" + w + "x" + h + "</span>" +
      "<span>Seq:" + seq + "</span>" +
      "<span>" + jpeg.length + "B</span>" +
      "<span>Lat:" + lat + "ms</span>" +
      "<span>Drop:" + drops + "</span>";
  };
  ws.onclose = () => { hud.innerHTML = "<span>RECONNECTING...</span>"; setTimeout(connect, 2000); };
  ws.onerror = () => { setTimeout(connect, 2000); };
}
connect();
</script>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/stats") {
      return new Response(JSON.stringify({
        publishers: publishers.size,
        viewers: viewers.size,
        frameCount,
        lastFrameTime: lastFrameTime ? new Date(lastFrameTime).toISOString() : null,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(VIEWER_HTML, { headers: { "Content-Type": "text/html" } });
    }

    return server.upgrade(req);
  },
  websocket: {
    open(ws) {
      const url = new URL(ws.url);
      if (url.pathname === "/publish") {
        publishers.set("ios", ws);
        console.log("[Relay] Publisher connected");
      } else {
        viewers.add(ws);
        console.log(`[Relay] Viewer connected (${viewers.size})`);
      }
    },
    message(ws, message) {
      if (typeof message === "string") {
        console.log("[Relay] Text:", message);
        return;
      }
      frameCount++;
      lastFrameTime = Date.now();
      for (const viewer of viewers) {
        try { viewer.send(message); } catch { viewers.delete(viewer); }
      }
    },
    close(ws) {
      if (publishers.get("ios") === ws) {
        publishers.delete("ios");
        console.log("[Relay] Publisher disconnected");
      } else {
        viewers.delete(ws);
        console.log(`[Relay] Viewer disconnected (${viewers.size})`);
      }
    },
  },
});

console.log(`[Relay] Server on :${PORT}`);
console.log(`[Relay] Publisher: ws://172.31.29.240:${PORT}/publish`);
console.log(`[Relay] Viewer:   http://172.31.29.240:${PORT}`);
