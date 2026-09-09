import { defineConfig } from "@playwright/test";
import { validateHostedPreflight } from "./preflight";

const { baseUrl } = validateHostedPreflight(process.env);

export default defineConfig({
  testDir: ".",
  testMatch: "hosted-access.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["./sanitized-reporter.ts"]],
  use: {
    baseURL: baseUrl,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "chrome" : undefined),
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
