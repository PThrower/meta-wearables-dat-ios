import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // WebSocket routes go directly to relay server (no gateway hop)
      "/publish": { target: "http://localhost:8080", ws: true },
      "/view":    { target: "http://localhost:8080", ws: true },
      "/tap":     { target: "http://localhost:8080", ws: true },

      // HTTP API routes go through auth gateway (matches Caddy routing)
      "/sessions":   "http://localhost:3000",
      "/gallery/api":  "http://localhost:3000",
      "/gallery":  "http://localhost:3000",
      "/session":  "http://localhost:3000",
      "/stats":    "http://localhost:3000",
      "/latest":   "http://localhost:3000",
      "/api":      "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        landing: resolve(__dirname, "landing.html"),
      },
      external: ["three"],
    },
  },
});
