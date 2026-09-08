import { expect, test, type Page } from "@playwright/test";
import {
  ARCOTEX_SHADOW_KEY_ENV,
  ARCOTEX_SHADOW_KEY_HEADER,
  ARCOTEX_SHADOW_SCENARIO_HEADER,
  type ArcotexShadowScenario,
} from "./support/arcotex-shadow-constants";

const browserErrors = new WeakMap<Page, string[]>();

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

async function setScenario(page: Page, scenario: ArcotexShadowScenario): Promise<void> {
  const key = process.env[ARCOTEX_SHADOW_KEY_ENV];
  if (!key) throw new Error("Falta la clave efímera del harness ARCOTEX.");
  await page.setExtraHTTPHeaders({
    [ARCOTEX_SHADOW_KEY_HEADER]: key,
    [ARCOTEX_SHADOW_SCENARIO_HEADER]: scenario,
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test.beforeEach(async ({ page }) => {
  await setScenario(page, "ready");
  await page.route("**/dashboard/import-asistencia?**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
  });
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "el navegador no debe emitir errores").toEqual([]);
});

test("rechaza entradas sin clave o con una clave incorrecta", async ({ baseURL }) => {
  const target = new URL("/dashboard", baseURL);
  const missingKey = await fetch(target);
  const wrongKey = await fetch(target, {
    headers: { [ARCOTEX_SHADOW_KEY_HEADER]: "clave-sintetica-incorrecta" },
  });

  expect(missingKey.status).toBe(404);
  expect(wrongKey.status).toBe(404);
});

test("entra al workspace ARCOTEX y opera Hoy, Ayer y una fecha elegida", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: /Buenos días, Usuario/ })).toBeVisible();
  await expect(page.getByText("ARCOTEX", { exact: true }).first()).toBeVisible();

  const primaryNavigation = page.getByRole("complementary", { name: "Navegación principal" });
  await expect(primaryNavigation.getByRole("link", { name: "Resumen Diario" })).toHaveAttribute("aria-current", "page");

  const periodNavigation = page.getByRole("navigation", { name: "Período del resumen" });
  const dateInput = page.getByLabel("Elegir fecha");
  const today = await dateInput.inputValue();
  const yesterday = shiftDate(today, -1);
  const customDate = shiftDate(today, -2);

  await periodNavigation.getByRole("link", { name: "Ayer" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/dashboard" && url.searchParams.get("fecha") === yesterday);
  await expect(dateInput).toHaveValue(yesterday);

  await dateInput.fill(customDate);
  const submitDate = page.getByRole("button", { name: "Ver fecha" });
  await submitDate.focus();
  await expect(submitDate).toBeFocused();
  await submitDate.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === "/dashboard" && url.searchParams.get("fecha") === customDate);

  await periodNavigation.getByRole("link", { name: "Hoy" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/dashboard" && url.searchParams.get("fecha") === today);
});

test("navega por teclado a Revisión diaria, cambia fecha y área, y distingue pendientes de sin novedades", async ({ page }) => {
  await page.goto("/dashboard");
  const pendingNavigation = page
    .getByRole("complementary", { name: "Navegación principal" })
    .getByRole("link", { name: "Pendientes" });

  await pendingNavigation.focus();
  await expect(pendingNavigation).toBeFocused();
  await pendingNavigation.press("Enter");

  await expect(page).toHaveURL(/\/revision-diaria/);
  await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Caso Sintético Pendiente/ })).toBeVisible();
  await expect(page.getByText("Sin novedades (1)", { exact: false })).toBeVisible();

  const todayLink = page.getByRole("navigation", { name: "Navegación de fecha" }).getByRole("link", { name: "Hoy" });
  const today = new URL(await todayLink.getAttribute("href") ?? "", "http://local").searchParams.get("fecha");
  expect(today).not.toBeNull();

  await page.getByRole("link", { name: "Día anterior" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("fecha") === shiftDate(today!, -1));
  await expect(page.getByText(/Revisión completada — no quedan casos pendientes/)).toBeVisible();

  await page.getByRole("navigation", { name: "Navegación de fecha" }).getByRole("link", { name: "Hoy" }).click();
  await expect(page).toHaveURL((url) =>
    url.searchParams.get("fecha") === today && url.searchParams.get("area") === "PRODUCTION"
  );
  await page.getByRole("navigation", { name: "Área" }).getByRole("link", { name: "Instalación" }).click();
  await expect(page).toHaveURL((url) =>
    url.searchParams.get("fecha") === today && url.searchParams.get("area") === "INSTALLATION"
  );
  await expect(page.getByText(/Revisión completada — no quedan casos pendientes para Instalación/)).toBeVisible();
  await expect(page.getByText("Sin novedades (1)", { exact: false })).toBeVisible();
});

test("recorre Licencias y Horarios con las páginas y componentes reales", async ({ page }) => {
  await page.goto("/licencias");

  await expect(page.getByRole("heading", { name: "Licencias", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Licencias pendientes de aprobación" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Empleados (4)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Caso Sintético Sin Novedades", exact: true })).toBeVisible();

  const schedulesLink = page
    .getByRole("complementary", { name: "Navegación principal" })
    .getByRole("link", { name: "Horarios" });
  await schedulesLink.click();

  await expect(page).toHaveURL(/\/configuracion\/horarios/);
  await expect(page.getByRole("heading", { name: "Horarios", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cobertura de horarios" })).toBeVisible();
  await expect(
    page.getByRole("row", {
      name: /Caso Sintético Pendiente Producción Horario sintético planta/,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Sin horario \(1\)/ })).toBeVisible();
});

test("muestra carga, error seguro y un reintento funcional", async ({ page }) => {
  await setScenario(page, "slow-review");
  await page.goto("/revision-diaria", { waitUntil: "commit" });

  await expect(page.getByRole("status", { name: "Cargando revisión diaria" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();

  await setScenario(page, "review-error");
  await page.goto("/revision-diaria");
  await expect(page.locator("main").getByRole("alert")).toContainText("No pudimos cargar esta información.");

  await setScenario(page, "ready");
  await page.getByRole("link", { name: "Reintentar" }).click();
  await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Caso Sintético Pendiente/ })).toBeVisible();
});

test.describe("flujo móvil", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mantiene navegación comprensible y sin overflow horizontal", async ({ page }) => {
    await page.goto("/dashboard");

    const primaryNavigation = page.getByRole("complementary", { name: "Navegación principal" });
    const summaryLink = primaryNavigation.getByRole("link", { name: "Resumen Diario", exact: true });
    const pendingLink = primaryNavigation.getByRole("link", { name: "Pendientes", exact: true });

    await expect(summaryLink).toBeVisible();
    await expect(summaryLink).toHaveAttribute("aria-current", "page");
    await expect(pendingLink).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await pendingLink.click();
    await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Navegación de fecha" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Área" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator("summary").filter({ hasText: "Sin novedades (1)" }).click();
    await expect(page.getByRole("link", { name: /Caso Sintético Sin Novedades/ })).toBeVisible();
  });
});

test.describe("teléfono compacto", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("recorre lista y detalle sin perder contexto ni crear overflow", async ({ page }) => {
    await page.goto("/revision-diaria");

    await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const pendingCase = page.getByRole("link", { name: /Caso Sintético Pendiente/ });
    await pendingCase.focus();
    await expect(pendingCase).toBeFocused();
    await pendingCase.press("Enter");

    await expect(page).toHaveURL((url) => url.searchParams.has("empleado"));
    await expect(page.getByRole("complementary", { name: "Detalle de Caso Sintético Pendiente" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Volver a la lista" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const backToList = page.getByRole("link", { name: "Volver a la lista" });
    await backToList.focus();
    await backToList.press("Enter");
    await expect(page).toHaveURL((url) => !url.searchParams.has("empleado"));
    await expect(page.getByRole("link", { name: /Caso Sintético Pendiente/ })).toBeVisible();
  });

  test("mantiene comprensibles los estados de carga, error, reintento y vacío", async ({ page }) => {
    await setScenario(page, "slow-review");
    await page.goto("/revision-diaria", { waitUntil: "commit" });
    await expect(page.getByRole("status", { name: "Cargando revisión diaria" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();

    await setScenario(page, "review-error");
    await page.goto("/revision-diaria");
    await expect(page.locator("main").getByRole("alert")).toContainText("No pudimos cargar esta información.");
    await expectNoHorizontalOverflow(page);

    await setScenario(page, "ready");
    const retryLink = page.getByRole("link", { name: "Reintentar" });
    await retryLink.focus();
    await retryLink.press("Enter");
    await expect(page.getByRole("heading", { name: "Pendientes", level: 1 })).toBeVisible();

    await page.getByRole("navigation", { name: "Área" }).getByRole("link", { name: "Instalación" }).click();
    await expect(page.getByText(/Revisión completada — no quedan casos pendientes para Instalación/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("permite colapsar y expandir la navegación con teclado", async ({ page }) => {
    await page.goto("/dashboard");

    const primaryNavigation = page.getByRole("complementary", { name: "Navegación principal" });
    const collapseButton = primaryNavigation.getByRole("button", { name: "Colapsar navegación" });
    await expect(primaryNavigation.getByRole("link", { name: "Resumen Diario", exact: true })).toBeVisible();
    await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    await expectNoHorizontalOverflow(page);

    await collapseButton.focus();
    await collapseButton.press("Enter");
    const expandButton = primaryNavigation.getByRole("button", { name: "Expandir navegación" });
    await expect(expandButton).toHaveAttribute("aria-expanded", "false");
    await expect(primaryNavigation.getByRole("link", { name: "Pendientes", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await expandButton.press("Enter");
    await expect(primaryNavigation.getByRole("button", { name: "Colapsar navegación" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

test("ofrece un salto de teclado directo al contenido principal", async ({ page }) => {
  await page.goto("/dashboard");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Saltar al contenido principal" });
  await expect(skipLink).toBeVisible();
  await expect(skipLink).toBeFocused();

  await skipLink.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("expone el progreso diario a tecnologías de asistencia", async ({ page }) => {
  await page.goto("/revision-diaria");

  const progress = page.getByRole("progressbar", { name: "Progreso de revisión diaria" });
  await expect(progress).toHaveAttribute("aria-valuemin", "0");
  await expect(progress).toHaveAttribute("aria-valuemax", "100");
  await expect(progress).toHaveAttribute("aria-valuenow", "50");
  await expect(progress).toHaveAttribute("aria-valuetext", "1 de 2 trabajadores revisados");
});
