import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "npm --prefix .. run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
