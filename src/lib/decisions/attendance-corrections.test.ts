import { test } from "node:test";
import assert from "node:assert/strict";
import { submitAttendanceCorrection } from "./attendance-corrections";

function mockSupabase(insertedRows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      if (table !== "attendance_corrections") throw new Error(`unexpected table ${table}`);
      return {
        update() {
          return this;
        },
        eq() {
          return this;
        },
        insert(row: Record<string, unknown>) {
          insertedRows.push(row);
          return this;
        },
        select() {
          return this;
        },
        single() {
          return Promise.resolve({ data: { id: "correction-1" }, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const BASE_INPUT = {
  attendanceRecordId: "att-1",
  employeeId: "emp-1",
  workDate: "2026-09-01",
  correctedClockIn: null,
  reason: "turno nocturno, olvidó marcar salida",
  correctedBy: "profile-1",
};

test("submitAttendanceCorrection: salida sin correctedClockOutNextDay se ancla al mismo work_date", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  await submitAttendanceCorrection(supabase, { ...BASE_INPUT, correctedClockOut: "17:30" });

  const clockOut = new Date(inserted[0].corrected_clock_out as string);
  // 17:30 Santiago (UTC-4 sin DST en esta fecha) = 21:30Z, mismo 2026-09-01.
  assert.equal(clockOut.toISOString().slice(0, 10), "2026-09-01");
});

test("submitAttendanceCorrection: correctedClockOutNextDay=true mueve la salida al día calendario SIGUIENTE (turno que cruza medianoche) -- regresión del bug encontrado en auditoría", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  // Turno nocturno: entrada 2026-09-01 22:00 (dato crudo, no tocado acá),
  // salida real 2026-09-02 06:00 -- el supervisor la declara explícitamente
  // como "día siguiente".
  await submitAttendanceCorrection(supabase, {
    ...BASE_INPUT,
    correctedClockOut: "06:00",
    correctedClockOutNextDay: true,
  });

  const clockOut = new Date(inserted[0].corrected_clock_out as string);
  assert.equal(
    clockOut.toISOString().slice(0, 10),
    "2026-09-02",
    "sin la bandera, esto se calculaba mal como 2026-09-01 06:00 -- 24 horas antes de la hora real"
  );
});

test("submitAttendanceCorrection: correctedClockOutNextDay ausente (undefined) se comporta igual que false", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  await submitAttendanceCorrection(supabase, { ...BASE_INPUT, correctedClockOut: "17:30" });

  const clockOut = new Date(inserted[0].corrected_clock_out as string);
  assert.equal(clockOut.toISOString().slice(0, 10), "2026-09-01");
});
