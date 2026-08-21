import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceExportRows, buildAttendanceExportWorkbook } from "./attendance-export";
import type { AttendanceExportPeriod } from "./attendance-export-periods";

/**
 * `buildAttendanceExportRows` nunca inventa un estado: un día sin fila
 * `is_current` en attendance_status_records queda "?" (el código ya
 * definido para "tarjeta no marcada o con problemas"), nunca P/F asumido.
 * El scoping de área reutiliza `areasVisibleToRole` -- mismo criterio que
 * el resto de la app (dashboard, revisión diaria, licencias).
 */

function mockSupabase(opts: {
  employees: { id: string; display_name: string; group: string }[];
  statuses: { employee_id: string; work_date: string; code: string }[];
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "employees") {
        return {
          select() {
            return {
              eq() {
                return {
                  in(_col: string, areas: string[]) {
                    return {
                      order() {
                        const filtered = opts.employees.filter((e) => areas.includes(e.group));
                        return Promise.resolve({
                          data: filtered.map((e) => ({ id: e.id, display_name: e.display_name, employee_groups: { code: e.group } })),
                          error: null,
                        });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "attendance_status_records") {
        return {
          select() {
            return {
              in(_col: string, employeeIds: string[]) {
                return {
                  gte(_c: string, start: string) {
                    return {
                      lte(_c2: string, end: string) {
                        return {
                          eq() {
                            const rows = opts.statuses.filter((s) => employeeIds.includes(s.employee_id) && s.work_date >= start && s.work_date <= end);
                            return Promise.resolve({ data: rows.map((r) => ({ employee_id: r.employee_id, work_date: r.work_date, attendance_statuses: { code: r.code } })), error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`mockSupabase: tabla no soportada: ${table}`);
    },
  };
  return client;
}

const WEEK_PERIOD: AttendanceExportPeriod = { type: "SEMANAL", startDate: "2026-08-17", endDate: "2026-08-21", label: "Semana de prueba" };

test("buildAttendanceExportRows: un día sin attendance_status_records -> '?', nunca P/F inventado", async () => {
  const supabase = mockSupabase({
    employees: [{ id: "emp-1", display_name: "Trabajador Uno", group: "PRODUCTION" }],
    statuses: [],
  });

  const rows = await buildAttendanceExportRows(supabase, "SUPERVISOR_PRODUCTION", WEEK_PERIOD);

  assert.equal(rows.length, 5, "lunes a viernes -- 5 días hábiles");
  assert.ok(rows.every((r) => r.statusCode === "?"));
});

test("buildAttendanceExportRows: usa el código real de attendance_status_records cuando existe", async () => {
  const supabase = mockSupabase({
    employees: [{ id: "emp-1", display_name: "Trabajador Uno", group: "PRODUCTION" }],
    statuses: [{ employee_id: "emp-1", work_date: "2026-08-18", code: "L" }],
  });

  const rows = await buildAttendanceExportRows(supabase, "SUPERVISOR_PRODUCTION", WEEK_PERIOD);
  const tuesday = rows.find((r) => r.workDate === "2026-08-18");
  assert.equal(tuesday?.statusCode, "L");
  assert.ok(rows.filter((r) => r.workDate !== "2026-08-18").every((r) => r.statusCode === "?"));
});

test("buildAttendanceExportRows: un SUPERVISOR_PRODUCTION nunca ve empleados de otra área", async () => {
  const supabase = mockSupabase({
    employees: [
      { id: "emp-prod", display_name: "Prod Uno", group: "PRODUCTION" },
      { id: "emp-inst", display_name: "Inst Uno", group: "INSTALLATION" },
    ],
    statuses: [],
  });

  const rows = await buildAttendanceExportRows(supabase, "SUPERVISOR_PRODUCTION", WEEK_PERIOD);
  assert.ok(rows.every((r) => r.workerName === "Prod Uno"));
  assert.ok(!rows.some((r) => r.workerName === "Inst Uno"));
});

test("buildAttendanceExportRows: SUPER_ADMIN ve todas las áreas", async () => {
  const supabase = mockSupabase({
    employees: [
      { id: "emp-prod", display_name: "Prod Uno", group: "PRODUCTION" },
      { id: "emp-inst", display_name: "Inst Uno", group: "INSTALLATION" },
    ],
    statuses: [],
  });

  const rows = await buildAttendanceExportRows(supabase, "SUPER_ADMIN", WEEK_PERIOD);
  const names = new Set(rows.map((r) => r.workerName));
  assert.ok(names.has("Prod Uno") && names.has("Inst Uno"));
});

test("buildAttendanceExportWorkbook: genera un archivo xlsx no vacío con las filas dadas", () => {
  const workbook = buildAttendanceExportWorkbook(
    [{ employeeId: "emp-1", workerName: "Trabajador Uno", area: "PRODUCTION", workDate: "2026-08-17", statusCode: "P" }],
    WEEK_PERIOD
  );
  assert.ok(workbook.byteLength > 0);
});
