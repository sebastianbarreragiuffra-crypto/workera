import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";
import {
  ARCOTEX_SHADOW_KEY_ENV,
  ARCOTEX_SHADOW_KEY_HEADER,
} from "./tests/e2e/support/arcotex-shadow-constants";

const port = Number(process.env.ARCOTEX_SHADOW_E2E_PORT ?? "3107");
const baseURL = `http://127.0.0.1:${port}`;
const browserChannel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "chrome" : undefined);
const ephemeralKey = process.env[ARCOTEX_SHADOW_KEY_ENV] ?? randomUUID();

// El spec y el servidor controlado comparten una clave efímera.
process.env[ARCOTEX_SHADOW_KEY_ENV] = ephemeralKey;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "arcotex-shadow-flow.spec.ts",
  globalSetup: "./tests/e2e/support/arcotex-shadow-global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    channel: browserChannel,
    extraHTTPHeaders: {
      [ARCOTEX_SHADOW_KEY_HEADER]: ephemeralKey,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
