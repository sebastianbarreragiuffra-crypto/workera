import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática, mismo criterio que `seguridad/mfa/actions.test.ts`: este
 * route handler no se puede ejercitar sin un intercambio OAuth real, así que
 * lo que se fija acá es la propiedad que no debe volver a perderse.
 *
 * Las dos formas de crear sesión tienen que decidir el segundo factor igual.
 * Este handler redirigía siempre a `/`, de modo que una cuenta privilegiada
 * que entraba por Google no recibía el desafío mientras el bloqueo estaba
 * apagado, que es justo el período en que hay que comprobar que el flujo
 * funciona antes de encenderlo.
 */
const ROUTE_PATH = path.join(import.meta.dirname, "route.ts");
const LOGIN_ACTIONS_PATH = path.join(import.meta.dirname, "..", "..", "login", "actions.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("el callback de OAuth resuelve el destino con la misma función que el login por contraseña", () => {
  const callback = readSource(ROUTE_PATH);
  const login = readSource(LOGIN_ACTIONS_PATH);

  assert.match(callback, /resolvePostLoginDestination/, "el callback debe resolver el destino post-login");
  assert.match(login, /resolvePostLoginDestination/, "el login por contraseña ya lo hacía");
});

test("el callback ya no redirige incondicionalmente a la raíz", () => {
  const callback = readSource(ROUTE_PATH);
  assert.doesNotMatch(
    callback,
    /NextResponse\.redirect\(`\$\{origin\}\/`\)/,
    "un redirect fijo a / se salta la decisión de segundo factor"
  );
});

test("si el estado de segundo factor no se puede leer, elimina la sesión parcial y vuelve al login", () => {
  const callback = readSource(ROUTE_PATH);
  const catchStart = callback.indexOf("catch {");
  const catchBody = callback.slice(catchStart, callback.indexOf("\n      }", catchStart));

  assert.match(catchBody, /supabase\.auth\.signOut\(\)/, "la sesión incompleta no debe sobrevivir");
  assert.match(catchBody, /\/login\?error=security/, "el usuario recibe un error recuperable en el login");
  assert.doesNotMatch(catchBody, /\/seguridad\/mfa/, "una lectura fallida no debe mandar a otra pantalla que depende de ella");
});

test("el error registrado no lleva claims, token, correo ni el mensaje del proveedor", () => {
  const callback = readSource(ROUTE_PATH);
  for (const match of callback.matchAll(/console\.[a-z]+\([\s\S]*?\)\;/g)) {
    assert.doesNotMatch(match[0], /claims|token|email|error\.message|code/i);
  }
});
