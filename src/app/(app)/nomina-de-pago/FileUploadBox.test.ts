import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Auditoría de arquitectura -- mismo bug ya encontrado y corregido en
 * RosterImportCard.tsx: un <input type="file"> oculto (`display:none`) y
 * `required` bloquea el submit del navegador sin poder mostrar la burbuja
 * de validación (no es enfocable). Si el usuario hace clic en "Subir
 * archivo" sin haber seleccionado/arrastrado un archivo primero, el submit
 * queda silenciosamente bloqueado -- ningún error visible. El backstop real
 * (Server Action valida `file.size === 0`) sigue existiendo y ahora sí
 * puede correr.
 */
const SOURCE_PATH = path.join(import.meta.dirname, "FileUploadBox.tsx");
const readSource = () => readFileSync(SOURCE_PATH, "utf8");

test("FileUploadBox: el input de archivo oculto NO es required -- el Server Action es el backstop real, visible", () => {
  const codeOnly = readSource().replace(/\/\*[\s\S]*?\*\//g, "");
  const inputStart = codeOnly.indexOf("<input");
  const inputEnd = codeOnly.indexOf("/>", inputStart);
  const inputTag = codeOnly.slice(inputStart, inputEnd);
  assert.match(inputTag, /type="file"/);
  assert.doesNotMatch(inputTag, /\brequired\b/, "un input de archivo oculto y required bloquea el submit sin mostrar ningún error");
});
