import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveSafeArcotexEnvironmentPath } from "./arcotex-local-file-safety";

const repositoryRoot = path.resolve("C:/workspace/workera");

test("permite sólo los archivos de entorno privados previstos", () => {
  assert.equal(
    resolveSafeArcotexEnvironmentPath(path.join(repositoryRoot, ".env.local"), repositoryRoot),
    path.join(repositoryRoot, ".env.local"),
  );
  assert.equal(
    resolveSafeArcotexEnvironmentPath(path.join(repositoryRoot, ".env.staging"), repositoryRoot),
    path.join(repositoryRoot, ".env.staging"),
  );
});

test("rechaza ejemplos, archivos versionables y rutas externas", () => {
  for (const candidate of [
    path.join(repositoryRoot, ".env.example"),
    path.join(repositoryRoot, ".env.staging.example"),
    path.join(repositoryRoot, "padrón.txt"),
    path.join(repositoryRoot, "tmp", ".env.local"),
    path.resolve(repositoryRoot, "..", ".env.staging"),
  ]) {
    assert.throws(
      () => resolveSafeArcotexEnvironmentPath(candidate, repositoryRoot),
      /sólo puede escribirse/,
    );
  }
});
