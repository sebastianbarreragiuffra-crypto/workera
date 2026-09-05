import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { FORBIDDEN_REALM_DEPENDENCIES, LIBRARY_MODULES } from "./module-boundaries";

const LIB_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return sourceFiles(fullPath);
    if (!SOURCE_EXTENSION.test(entry) || /\.(?:test|spec)\.[^.]+$/.test(entry)) return [];
    return [fullPath];
  });
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function targetLibraryModule(sourceFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/lib/")) return specifier.slice("@/lib/".length).split("/")[0] || null;
  if (!specifier.startsWith(".")) return null;

  const resolved = path.resolve(path.dirname(sourceFile), specifier);
  const relative = path.relative(LIB_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] || null;
}

test("cada directorio de src/lib tiene un owner y un dominio arquitectónico", () => {
  const actual = readdirSync(LIB_ROOT)
    .filter((entry) => statSync(path.join(LIB_ROOT, entry)).isDirectory())
    .sort();
  assert.deepEqual(actual, Object.keys(LIBRARY_MODULES).sort());

  for (const [moduleName, definition] of Object.entries(LIBRARY_MODULES)) {
    assert.ok(definition.owner.trim(), `${moduleName} debe declarar owner`);
    assert.ok(definition.purpose.trim(), `${moduleName} debe declarar propósito`);
  }
});

test("los dominios no importan directamente implementaciones de otro dominio", () => {
  const violations: string[] = [];

  for (const sourceFile of sourceFiles(LIB_ROOT)) {
    const sourceModule = path.relative(LIB_ROOT, sourceFile).split(path.sep)[0];
    const sourceDefinition = LIBRARY_MODULES[sourceModule as keyof typeof LIBRARY_MODULES];
    assert.ok(sourceDefinition, `${sourceModule} no está registrado`);

    for (const specifier of importedSpecifiers(readFileSync(sourceFile, "utf8"))) {
      const targetModule = targetLibraryModule(sourceFile, specifier);
      if (!targetModule || targetModule === sourceModule) continue;
      const targetDefinition = LIBRARY_MODULES[targetModule as keyof typeof LIBRARY_MODULES];
      if (!targetDefinition) {
        violations.push(`${path.relative(LIB_ROOT, sourceFile)} -> módulo desconocido ${targetModule}`);
        continue;
      }

      const forbidden = FORBIDDEN_REALM_DEPENDENCIES[sourceDefinition.realm];
      if (forbidden.includes(targetDefinition.realm)) {
        violations.push(
          `${path.relative(LIB_ROOT, sourceFile)} (${sourceDefinition.realm}) -> ${specifier} (${targetDefinition.realm})`
        );
      }
    }
  }

  assert.deepEqual(violations, [], `Dependencias que rompen el monolito modular:\n${violations.join("\n")}`);
});
