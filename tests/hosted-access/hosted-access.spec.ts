import { createHmac } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { test, type Page, type TestInfo } from "@playwright/test";
import { validateHostedPreflight } from "./preflight";

type RoleKey = "RRHH" | "PRODUCTION" | "INSTALLATION" | "NO_ACCESS";
type Area = "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";

const outputDir = process.env.HOSTED_RESULTS_DIR ?? "test-results/hosted-access-sanitized";
const resultsPath = `${outputDir}/results.jsonl`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostedPreflight = validateHostedPreflight(process.env);

function assertSanitized(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta ${name}.`);
  return value;
}

function syntheticId(name: string): string {
  const value = required(name);
  if (!uuid.test(value)) throw new Error(`${name} debe ser UUID.`);
  return value;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/\s|=/g, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Secreto TOTP inválido.");
    bits += index.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
}

function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function login(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(required(`HOSTED_${role}_EMAIL`));
  await page.getByLabel("Contraseña").fill(required(`HOSTED_${role}_PASSWORD`));
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  const secret = required(`HOSTED_${role}_TOTP_SECRET`);
  if (page.url().includes("/login/mfa")) {
    await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
    await page.getByRole("button", { name: "Verificar" }).click();
  }
  await page.waitForLoadState("networkidle");

  // Esta ruta consulta claims verificados en servidor: sólo una sesión aal2
  // abandona las pantallas MFA. Así el arnés no confunde "pudo entrar" con
  // "demostró segundo factor".
  await page.goto("/login/mfa?next=/");
  await page.waitForLoadState("networkidle");
  const path = new URL(page.url()).pathname;
  assertSanitized(
    path !== "/login/mfa" && path !== "/seguridad/mfa" && path !== "/login",
    `La sesión ${role} no acreditó AAL2.`,
  );
}

async function safeBody(page: Page) {
  const body = await page.locator("body").innerText();
  for (const name of ["HOSTED_FORBIDDEN_CANARY_AREA", "HOSTED_FORBIDDEN_CANARY_COMPANY", "HOSTED_FORBIDDEN_CANARY_ROSTER"]) {
    const canary = required(name);
    assertSanitized(!body.includes(canary), `Se detectó una fuga del canario ${name}.`);
  }
  return body;
}

async function record(info: TestInfo) {
  await mkdir(outputDir, { recursive: true });
  await appendFile(resultsPath, `${JSON.stringify({ case: info.titlePath.slice(1).join(" / "), status: info.status })}\n`, "utf8");
}

test.beforeAll(async () => {
  await mkdir(outputDir, { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify({
    type: "run",
    candidateSha: hostedPreflight.candidateSha,
    deployedSha: hostedPreflight.deployedSha,
    gateSha: hostedPreflight.gateSha,
    authorizationDigest: hostedPreflight.authorizationDigest,
    deploymentEvidenceDigest: hostedPreflight.deploymentEvidenceDigest,
    windowStartUtc: hostedPreflight.windowStartUtc,
    windowEndUtc: hostedPreflight.windowEndUtc,
    executionApprovalValidated: true,
    operatorAal2Validated: true,
  })}\n`, "utf8");
});
test.afterEach(async ({}, info) => record(info));

const areaLabel: Record<Area, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const roles: { key: Exclude<RoleKey, "NO_ACCESS">; label: RegExp; areas: Area[]; denied: Area[] }[] = [
  { key: "RRHH", label: /RRHH/, areas: ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"], denied: [] },
  { key: "PRODUCTION", label: /Supervisor Producción/, areas: ["PRODUCTION"], denied: ["INSTALLATION", "ADMINISTRATION"] },
  { key: "INSTALLATION", label: /Supervisor Instalación/, areas: ["INSTALLATION"], denied: ["PRODUCTION", "ADMINISTRATION"] },
];

for (const role of roles) {
  test.describe(role.key, () => {
    test.beforeEach(async ({ page }) => login(page, role.key));

    test("navegación y lecturas quedan limitadas al rol", async ({ page }) => {
      assertSanitized(await page.getByText(role.label).first().isVisible(), `El rol ${role.key} no quedó visible.`);
      for (const area of role.areas) {
        await page.goto(`/revision-diaria?area=${area}&filtro=todos`);
        assertSanitized(
          await page.getByText(areaLabel[area], { exact: false }).first().isVisible(),
          `El área permitida ${area} no quedó visible para ${role.key}.`,
        );
        await safeBody(page);
      }
      for (const area of role.denied) {
        await page.goto(`/revision-diaria?area=${area}&filtro=todos`);
        assertSanitized(
          await page.getByText("No tienes acceso a esta área.").isVisible(),
          `El área denegada ${area} no falló cerrada para ${role.key}.`,
        );
        await safeBody(page);
      }
    });

    test("IDOR de otra área, empresa y fuera del padrón no revela PII", async ({ page }) => {
      await page.goto(`/empleados/${syntheticId(`HOSTED_${role.key}_ALLOWED_EMPLOYEE_ID`)}`);
      assertSanitized(
        await page.getByRole("link", { name: "Revisar hoy" }).isVisible(),
        `El fixture permitido no quedó disponible para ${role.key}.`,
      );
      await safeBody(page);

      const ids = [
        ...(role.key === "RRHH" ? [] : [syntheticId(`HOSTED_${role.key}_DENIED_AREA_EMPLOYEE_ID`)]),
        syntheticId("HOSTED_OTHER_COMPANY_EMPLOYEE_ID"),
        syntheticId("HOSTED_OUTSIDE_ROSTER_EMPLOYEE_ID"),
      ];
      for (const id of ids) {
        await page.goto(`/empleados/${id}`);
        const body = await safeBody(page);
        assertSanitized(
          /No tienes acceso|No encontramos|No pudimos|Acceso pendiente/i.test(body),
          `Una lectura IDOR no falló cerrada para ${role.key}.`,
        );
      }
    });

    test("operaciones sensibles disponibles coinciden con el rol", async ({ page }) => {
      const privileged = ["/nomina-de-pago", "/periodos", "/configuracion/horarios", "/exportaciones"];
      for (const path of privileged) {
        await page.goto(path);
        const body = await safeBody(page);
        const currentPath = new URL(page.url()).pathname;
        if (role.key === "RRHH") {
          assertSanitized(
            currentPath !== "/acceso-pendiente" && currentPath !== "/login",
            "RRHH no pudo acceder a una operación privilegiada esperada.",
          );
        } else {
          assertSanitized(
            /No tienes acceso|Acceso pendiente/i.test(body) || ["/acceso-pendiente", "/dashboard", "/login"].includes(currentPath),
            `Una operación privilegiada no falló cerrada para ${role.key}.`,
          );
        }
      }
    });
  });
}

test.describe("usuario autenticado sin acceso", () => {
  test.beforeEach(async ({ page }) => login(page, "NO_ACCESS"));
  test("no obtiene shell, lecturas ni navegación corporativa", async ({ page }) => {
    for (const path of ["/dashboard", "/revision-diaria", "/licencias", `/empleados/${syntheticId("HOSTED_RRHH_ALLOWED_EMPLOYEE_ID")}`]) {
      await page.goto(path);
      await safeBody(page);
      const currentPath = new URL(page.url()).pathname;
      assertSanitized(
        currentPath.startsWith("/acceso-pendiente") || currentPath.startsWith("/empresas") || currentPath.startsWith("/login"),
        "El usuario sin acceso obtuvo navegación corporativa.",
      );
    }
  });
});
