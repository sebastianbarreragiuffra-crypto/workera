process.loadEnvFile?.(".env.local");

import { createHash } from "node:crypto";
import { generateLateArrivalCandidate } from "./src/lib/business-rules/late-arrival";
import { generateOvertimeCandidate } from "./src/lib/business-rules/overtime-confirmation";
import { generateEarlyDepartureCandidate } from "./src/lib/business-rules/early-departure";
import { createAdminClient } from "./src/lib/supabase/admin-client";

/**
 * Datos SOLO para verificación manual en navegador de Fase 8B.2 -- nunca
 * commiteados, nunca parte de la app. No hay credenciales reales de Workera
 * en este entorno, así que en vez de correr el pipeline de sync real, se
 * insertan `attendance_records` directamente con `source='manual'` (columna
 * ya soportada por el esquema real para este caso) y luego se corre el
 * motor de negocio REAL (generate*Candidate, sin modificar) sobre esos
 * registros -- igual que haría con datos sincronizados de Workera.
 */

const TODAY = "2026-08-19";

async function main() {
  const supabase = createAdminClient();

  const { data: adminProfile } = await supabase.from("profiles").insert({ display_name: "Admin Setup (local)", role: "SUPER_ADMIN", active: true }).select("id").single();
  console.log("admin profile:", adminProfile?.id);

  const { data: prodGroup } = await supabase.from("employee_groups").select("id").eq("code", "PRODUCTION").single();
  if (!prodGroup) throw new Error("no PRODUCTION group");

  const { data: schedule } = await supabase.from("work_schedules").insert({ name: "General 08:00-17:00" }).select("id").single();
  if (!schedule) throw new Error("no schedule");
  await supabase.from("work_schedule_rules").insert([1, 2, 3, 4, 5].map((dow) => ({ work_schedule_id: schedule.id, day_of_week: dow, scheduled_start: "08:00:00", scheduled_end: "17:00:00" })));

  const employees = [
    { code: "TEST-001", first: "María", last: "Araya" }, // atraso
    { code: "TEST-002", first: "Juan", last: "Herrera" }, // horas extra
    { code: "TEST-003", first: "Pedro", last: "Fuentes" }, // clock out pendiente
    { code: "TEST-004", first: "Carlos", last: "López" }, // licencia
    { code: "TEST-005", first: "Ana", last: "Torres" }, // salida anticipada médica
    { code: "TEST-006", first: "Sofía", last: "Reyes" }, // cumpleaños hoy, sin novedades
  ];

  const employeeIds: Record<string, string> = {};
  for (const e of employees) {
    const { data: emp, error } = await supabase
      .from("employees")
      .insert({ external_workera_id: e.code, first_name: e.first, last_name: e.last, display_name: `${e.first} ${e.last}`, employee_group_id: prodGroup.id })
      .select("id")
      .single();
    if (error || !emp) throw new Error(`employee ${e.code}: ${error?.message}`);
    employeeIds[e.code] = emp.id;
    await supabase.from("schedule_assignments").insert({ employee_id: emp.id, work_schedule_id: schedule.id, effective_from: "2026-01-01" });
  }
  console.log("employees created:", Object.keys(employeeIds).length);

  function fingerprint(code: string, suffix: string) {
    return createHash("sha256").update(`${code}|${suffix}`).digest("hex");
  }

  async function insertAttendance(code: string, clockIn: string | null, clockOut: string | null) {
    const empId = employeeIds[code];
    const { data, error } = await supabase
      .from("attendance_records")
      .insert({
        employee_id: empId,
        work_date: TODAY,
        actual_clock_in: clockIn,
        actual_clock_out: clockOut,
        source: "manual",
        source_hash: fingerprint(code, `${clockIn}|${clockOut}`),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`attendance ${code}: ${error?.message}`);
    return data.id;
  }

  // María Araya: atraso 12 min
  const mariaAttId = await insertAttendance("TEST-001", `${TODAY}T12:12:00Z`, `${TODAY}T21:00:00Z`); // 08:12/17:00 Santiago (UTC-4)
  await generateLateArrivalCandidate(supabase, employeeIds["TEST-001"], TODAY, mariaAttId, `${TODAY}T12:12:00Z`);

  // Juan Herrera: horas extra 150 min (salida 19:30 vs 17:00)
  const juanAttId = await insertAttendance("TEST-002", `${TODAY}T12:00:00Z`, `${TODAY}T23:30:00Z`);
  await generateOvertimeCandidate(supabase, employeeIds["TEST-002"], TODAY, juanAttId, `${TODAY}T23:30:00Z`);

  // Pedro Fuentes: entrada sin salida (clock out pendiente)
  await insertAttendance("TEST-003", `${TODAY}T11:50:00Z`, null);

  // Ana Torres: salida anticipada (15:30 vs 17:00 = 90 min)
  const anaAttId = await insertAttendance("TEST-005", `${TODAY}T12:00:00Z`, `${TODAY}T19:30:00Z`);
  await generateEarlyDepartureCandidate(supabase, employeeIds["TEST-005"], TODAY, anaAttId, `${TODAY}T19:30:00Z`);

  // Sofía Reyes: día normal, sin novedades + cumpleaños hoy
  await insertAttendance("TEST-006", `${TODAY}T12:00:00Z`, `${TODAY}T21:00:00Z`);
  await supabase.from("employee_birthdays").insert({ employee_id: employeeIds["TEST-006"], birth_month: 8, birth_day: 19 });

  // Carlos López: licencia (absence_record, sin decisión -- ABSENCE pendiente)
  const { data: absenceType } = await supabase.from("absence_types").select("id").eq("code", "MEDICAL_LEAVE").single();
  await supabase.from("absence_records").insert({
    employee_id: employeeIds["TEST-004"],
    absence_type_id: absenceType!.id,
    start_date: TODAY,
    end_date: TODAY,
    source: "manual",
    source_hash: fingerprint("TEST-004", "absence"),
    created_by: adminProfile!.id,
  });

  console.log("Datos de prueba listos para", TODAY);
}
main().catch((e) => {
  console.error("SETUP FAILED:", e);
  process.exit(1);
});
