import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

const apiPort = process.env.ZUI_PORT ?? "3000";
const tsconfig = fileURLToPath(new URL("./tsconfig.web.json", import.meta.url));

export default defineConfig({
  root: "src/web",
  base: "/",
  plugins: [react(), tsconfigPaths({ projects: [tsconfig] })],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      "/health": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});