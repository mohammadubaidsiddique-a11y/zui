import { defineConfig, devices } from "@playwright/test";

const API_PORT = "3100";
const WEB_PORT = "4173";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `ZUI_PORT=${API_PORT} ZUI_DATA_DIR=.e2e-data tsx src/server/index.ts`,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ZUI_PORT: API_PORT, ZUI_DATA_DIR: ".e2e-data", ZUI_SESSION_TTL_MS: "3600000" },
    },
    {
      command: `ZUI_API_PORT=${API_PORT} vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ZUI_API_PORT: API_PORT },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});