import { defineConfig } from "@playwright/test";

const baseURL = process.env.HOSTED_BASE_URL;
if (!baseURL || !/^https:\/\//.test(baseURL)) {
  throw new Error("HOSTED_BASE_URL debe ser un origen HTTPS de staging.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "hosted-access.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "chrome" : undefined),
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
