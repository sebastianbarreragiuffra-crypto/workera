import { fork } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { ARCOTEX_SHADOW_KEY_ENV } from "./arcotex-shadow-constants";

const SHADOW_DIST_DIR = ".next-arcotex-shadow-e2e";

export default async function arcotexShadowGlobalSetup(config: FullConfig) {
  const configuredBaseURL = config.projects[0]?.use.baseURL;
  if (typeof configuredBaseURL !== "string") {
    throw new Error("El E2E ARCOTEX necesita un baseURL HTTP explícito.");
  }

  const url = new URL(configuredBaseURL);
  const workspace = process.cwd();
  const distDir = resolve(workspace, SHADOW_DIST_DIR);
  if (dirname(distDir) !== workspace) {
    throw new Error("El directorio temporal del E2E ARCOTEX debe quedar dentro del repositorio.");
  }
  await rm(distDir, { force: true, recursive: true });

  const serverPath = resolve(workspace, "tests/e2e/support/arcotex-shadow-server.mjs");
  const child = fork(serverPath, [], {
    cwd: workspace,
    env: {
      ...process.env,
      ARCOTEX_SHADOW_E2E: "enabled",
      ARCOTEX_SHADOW_E2E_HOSTNAME: url.hostname,
      ARCOTEX_SHADOW_E2E_PORT: url.port,
      NODE_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:59999",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "arcotex-shadow-e2e-anon-key",
      [ARCOTEX_SHADOW_KEY_ENV]: process.env[ARCOTEX_SHADOW_KEY_ENV],
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error("El servidor E2E ARCOTEX no quedó listo en 120 segundos."));
    }, 120_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`El servidor E2E ARCOTEX terminó antes de iniciar (código ${code}).`));
    });
    child.on("message", (message) => {
      if (message !== "ready") return;
      clearTimeout(timeout);
      resolveReady();
    });
  });

  return async () => {
    const stopped = new Promise<void>((resolveStopped, rejectStopped) => {
      const timeout = setTimeout(() => {
        child.kill();
        rejectStopped(new Error("El servidor E2E ARCOTEX no cerró en 15 segundos."));
      }, 15_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolveStopped();
        else rejectStopped(new Error(`El servidor E2E ARCOTEX cerró con código ${code}.`));
      });
    });
    child.send("shutdown");
    await stopped;
    await rm(distDir, { force: true, recursive: true });
  };
}
