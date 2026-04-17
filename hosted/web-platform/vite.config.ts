import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // All routes go through the gateway (port 3000)
      // Gateway proxies HTTP to relay server and handles WebSocket upgrade
      "/publish": { target: "http://localhost:3000", ws: true },
      "/view":    { target: "http://localhost:3000", ws: true },
      "/tap":     { target: "http://localhost:3000", ws: true },

      "/sessions":   "http://localhost:3000",
      "/gallery/api":  "http://localhost:3000",
      "/gallery":  "http://localhost:3000",
      "/session":  "http://localhost:3000",
      "/stats":    "http://localhost:3000",
      "/latest":   "http://localhost:3000",
      "/api":      "http://localhost:3000",
      "/telemetry": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        landing: resolve(__dirname, "landing.html"),
        telemetry: resolve(__dirname, "telemetry.html"),
      },
      external: ["three"],
    },
  },
});
