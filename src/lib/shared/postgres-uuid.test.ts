import assert from "node:assert/strict";
import test from "node:test";
import { postgresUuid } from "./postgres-uuid";

const ARCOTEX_COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

test("acepta el UUID histórico de ARCOTEX que PostgreSQL almacena", () => {
  assert.equal(postgresUuid.safeParse(ARCOTEX_COMPANY_ID).success, true);
});

test("sigue rechazando identificadores malformados o manipulados", () => {
  for (const value of ["arcotex", "", `${ARCOTEX_COMPANY_ID}'`, "0a4c0000-0000-0000-0000-00000000000g"]) {
    assert.equal(postgresUuid.safeParse(value).success, false);
  }
});
