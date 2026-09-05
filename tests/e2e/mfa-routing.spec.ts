import { expect, test } from "@playwright/test";

const RUNTIME_ERROR_TEXT = /Runtime Error|unexpected response was received from the server/i;

test("una ruta MFA privada sin sesión vuelve al login sin loop ni error de runtime", async ({ page }) => {
  await page.goto("/seguridad/mfa");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Bienvenido de nuevo" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(RUNTIME_ERROR_TEXT);
});

test("el desafío MFA sin sesión también vuelve al login", async ({ page }) => {
  await page.goto("/login/mfa");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(RUNTIME_ERROR_TEXT);
});

test("una credencial inválida usa la Server Action y conserva un error genérico", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("mfa-smoke@example.invalid");
  await page.locator('input[name="password"]').fill("Invalid-E2E-password-9z!");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('p[role="alert"]')).toHaveText("No pudimos iniciar sesión con esas credenciales.");
  await expect(page.locator("body")).not.toContainText(RUNTIME_ERROR_TEXT);
});
