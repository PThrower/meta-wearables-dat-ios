import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/publish": "http://localhost:8080",
      "/view":   "http://localhost:8080",
      "/sessions": "http://localhost:8080",
      "/gallery/api":  "http://localhost:8080",
      "/gallery":  "http://localhost:8080",
      "/session":  "http://localhost:8080",
      "/stats":    "http://localhost:8080",
      "/tap":      { target: "http://localhost:8080", ws: true },
      "/latest":   "http://localhost:8080",
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
