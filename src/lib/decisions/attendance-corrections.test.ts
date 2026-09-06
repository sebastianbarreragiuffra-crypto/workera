import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { submitAttendanceCorrection } from "./attendance-corrections";

function mockSupabase(rpcCalls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: "correction-1", error: null });
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
};

test("submitAttendanceCorrection: salida sin correctedClockOutNextDay se ancla al mismo work_date", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = mockSupabase(calls);

  const result = await submitAttendanceCorrection(supabase, { ...BASE_INPUT, correctedClockOut: "17:30" });

  assert.equal(calls.length, 1, "la corrección completa usa una sola llamada transaccional");
  assert.equal(calls[0].name, "replace_attendance_correction");
  assert.equal(result.correctionId, "correction-1");
  const clockOut = new Date(calls[0].args.p_corrected_clock_out as string);
  // 17:30 Santiago (UTC-4 sin DST en esta fecha) = 21:30Z, mismo 2026-09-01.
  assert.equal(clockOut.toISOString().slice(0, 10), "2026-09-01");
});

test("submitAttendanceCorrection: correctedClockOutNextDay=true mueve la salida al día calendario SIGUIENTE (turno que cruza medianoche) -- regresión del bug encontrado en auditoría", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = mockSupabase(calls);

  // Turno nocturno: entrada 2026-09-01 22:00 (dato crudo, no tocado acá),
  // salida real 2026-09-02 06:00 -- el supervisor la declara explícitamente
  // como "día siguiente".
  await submitAttendanceCorrection(supabase, {
    ...BASE_INPUT,
    correctedClockOut: "06:00",
    correctedClockOutNextDay: true,
  });

  const clockOut = new Date(calls[0].args.p_corrected_clock_out as string);
  assert.equal(
    clockOut.toISOString().slice(0, 10),
    "2026-09-02",
    "sin la bandera, esto se calculaba mal como 2026-09-01 06:00 -- 24 horas antes de la hora real"
  );
});

test("submitAttendanceCorrection: correctedClockOutNextDay ausente (undefined) se comporta igual que false", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = mockSupabase(calls);

  await submitAttendanceCorrection(supabase, { ...BASE_INPUT, correctedClockOut: "17:30" });

  const clockOut = new Date(calls[0].args.p_corrected_clock_out as string);
  assert.equal(clockOut.toISOString().slice(0, 10), "2026-09-01");
});

test("submitAttendanceCorrection: no desactiva primero la corrección vigente en una transacción HTTP separada", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = mockSupabase(calls);

  await submitAttendanceCorrection(supabase, { ...BASE_INPUT, correctedClockOut: "18:00" });

  assert.deepEqual(calls.map((call) => call.name), ["replace_attendance_correction"]);
  assert.equal(calls[0].args.p_reason, BASE_INPUT.reason);
  assert.ok(!("p_corrected_by" in calls[0].args), "el autor se deriva de auth.uid() en la base");
});

test("migración final: el reemplazo es atómico, valida identidad y cierra DML directo", () => {
  const sql = readFileSync(
    "supabase/migrations/20260906210000_payroll_revision_state_integrity.sql",
    "utf8",
  );

  assert.match(sql, /create or replace function public\.replace_attendance_correction[\s\S]*security definer[\s\S]*for update of ar/);
  assert.match(sql, /ar\.employee_id = p_employee_id[\s\S]*ar\.work_date = p_work_date[\s\S]*ar\.is_current/);
  assert.match(sql, /update public\.attendance_corrections[\s\S]*set is_current = false[\s\S]*insert into public\.attendance_corrections/);
  assert.match(sql, /revoke insert, update, delete on public\.attendance_corrections from authenticated/);
  assert.match(sql, /grant execute on function public\.replace_attendance_correction[\s\S]*to authenticated/);
});
