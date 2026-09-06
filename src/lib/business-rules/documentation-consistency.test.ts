import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("la documentación laboral distingue las reglas 2026 de las fases históricas", () => {
  const gateD = readRepoFile("docs/BUSINESS_RULES_GATE_D.md");
  const phase7 = readRepoFile("docs/BUSINESS_RULES_PHASE7.md");
  const phase2b = readRepoFile("docs/DATA_MODEL_PHASE2B.md");
  const access = readRepoFile("docs/ACCESS_MODEL_PHASE5D.md");

  assert.match(gateD, /Minutos reales y aprobados exactos — regla vigente/);
  assert.doesNotMatch(gateD, /approved_minutes ∈ \{0, 60, 120\}/);
  assert.doesNotMatch(gateD, /ciclo exacto \*\*sin confirmar\*\*/);

  assert.match(phase7, /SUPER_ADMIN` conserva lectura y auditoría, pero no decide ni reemplaza/);
  assert.match(phase7, /viernes sigue la regla lunes–viernes, HH50 y máximo 120 minutos/);
  assert.match(phase7, /`R` permanece inactivo solo por compatibilidad histórica/);

  assert.match(phase2b, /La regla final 2026 también cubre `INSTALLATION`/);
  assert.match(phase2b, /corte inclusivo 16 del mes anterior–15 del mes de remuneración/);
  assert.match(phase2b, /`R` histórico \(recuperan horas\) \| `BLOCKING`/);

  assert.match(access, /Matriz histórica de accesos de Fase 5D/);
  assert.match(access, /solo `ADMIN_RRHH` puede reemplazar o invalidar/);
  assert.match(access, /`SUPER_ADMIN` puede auditarla, nunca editarla, borrarla ni invalidarla/);
});
