import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.DATAQORE_WEB_URL ?? "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
  },
  reporter: "list",
});
