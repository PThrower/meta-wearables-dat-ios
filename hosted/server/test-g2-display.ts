/**
 * test-g2-display.ts
 *
 * Quick test: connects to local relay as a publisher with G2 display_viewer,
 * then sends display_frame messages to verify glasses HUD output.
 *
 * Usage: bun run test-g2-display.ts
 */

const RELAY_URL = "wss://relay.simulationapi.com/publish?session=test-g2";

const ws = new WebSocket(RELAY_URL);

ws.addEventListener("open", () => {
  console.log("[test] Connected to relay");

  // Send hello with G2 display_viewer
  const hello = {
    type: "hello",
    deviceName: "Test G2 Bridge",
    deviceModel: "iPhone",
    deviceId: "test-g2-bridge",
    display_viewer: {
      model: "even-g2",
      protocol: "protobuf",
    },
  };

  ws.send(JSON.stringify(hello));
  console.log("[test] Sent hello with G2 display_viewer");

  // Wait a moment for server to process hello, then start sending display frames
  setTimeout(() => sendDisplay(), 1000);
});

ws.addEventListener("message", (event) => {
  if (typeof event.data === "string") {
    console.log("[test] Received:", event.data.substring(0, 200));
  }
});

ws.addEventListener("error", (event) => {
  console.error("[test] WebSocket error:", event);
});

ws.addEventListener("close", () => {
  console.log("[test] Disconnected");
});

function sendDisplay() {
  const messages = [
    ["", "hey ebowwa", "", ""],
    ["", "hey ebowwa", "", "listening..."],
  ];

  let i = 0;

  const interval = setInterval(() => {
    if (i >= messages.length) {
      clearInterval(interval);
      console.log("[test] Display sequence complete");

      // Keep connection alive
      setTimeout(() => {
        console.log("[test] Closing...");
        ws.close();
      }, 5000);
      return;
    }

    const frame = {
      type: "display_frame",
      target: "even-g2",
      lines: messages[i],
      displayTarget: "main",
      priority: "normal",
    };

    ws.send(JSON.stringify(frame));
    console.log(`[test] Sent display_frame #${i + 1}:`, messages[i].join(" | "));
    i++;
  }, 3000);
}
