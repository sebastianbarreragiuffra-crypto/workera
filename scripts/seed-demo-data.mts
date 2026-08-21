import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/**
 * Seed de datos de demostración -- SOLO para Supabase Cloud STAGING, nunca
 * para local (que ya tiene datos reales de desarrollo) ni mucho menos para
 * un proyecto de producción real. Usa las mismas tablas/arquitectura reales
 * que el resto de la app (Fase 9, encargo "multi-user demo") -- nunca
 * hardcodea resultados en el frontend.
 *
 * Ejecutar SOLO manualmente, apuntado explícitamente a STAGING:
 *   npx tsx --conditions=react-server scripts/seed-demo-data.mts <path-a-.env-de-staging>
 *
 * Idempotente respecto a los EMPLEADOS (external_workera_id único, upsert),
 * pero NO reintenta limpiar datos parcialmente insertados de una corrida
 * fallida -- si algo falla a la mitad, correr `select * from
 * cleanup_demo_data();` (SUPER_ADMIN) antes de reintentar.
 */

const envPath = process.argv[2];
if (!envPath) {
  console.error("Uso: tsx scripts/seed-demo-data.mts <path-a-.env-de-staging>");
  process.exit(1);
}

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const clean = line.replace(/\r$/, "");
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(clean);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv(envPath);
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el archivo de env indicado.");
  process.exit(1);
}
// Guardrail: nunca correr esto contra un proyecto que "suene" a producción.
if (!SUPABASE_URL.includes("nmujzmtuihwigcuzwhbh")) {
  console.error(`REHUSADO: este script solo está autorizado contra el proyecto STAGING (nmujzmtuihwigcuzwhbh). URL detectada: ${SUPABASE_URL}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// --- Fechas: las DOS semanas laborales completas anteriores a la actual (America/Santiago). ---
const WEEK1 = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]; // lunes-viernes
const WEEK2 = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]; // lunes-viernes
const ALL_DAYS = [...WEEK1, ...WEEK2];

const STANDARD_SCHEDULE_ID = "e5177a93-36db-4c18-abf7-2e59d823088d";

function dayOfWeekIso(dateIso: string): number {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const jsDay = d.getUTCDay(); // 0=domingo..6=sábado
  return jsDay === 0 ? 7 : jsDay; // no se usa acá (solo lunes-viernes), pero consistente con 1..5
}

function scheduledTimesFor(dateIso: string): { start: string; end: string } {
  const iso = dayOfWeekIso(dateIso);
  return iso === 5 ? { start: "07:30:00", end: "14:50:00" } : { start: "07:30:00", end: "17:00:00" };
}

function sourceHash(...parts: string[]): string {
  // Hash simple y determinístico, suficiente para source_hash (no es un secreto, solo huella).
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `demo-${(h >>> 0).toString(16)}`;
}

async function must<T>(label: string, promise: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (data === null) throw new Error(`${label}: la respuesta no trajo datos.`);
  return data;
}

async function main() {
  console.log(`Sembrando datos de demostración en ${SUPABASE_URL}...`);

  const groups = await must<{ id: string; code: string }[]>(
    "employee_groups",
    supabase.from("employee_groups").select("id, code")
  );
  const groupId = Object.fromEntries(groups.map((g) => [g.code, g.id])) as Record<"PRODUCTION" | "INSTALLATION" | "ADMINISTRATION", string>;

  const statuses = await must<{ id: string; code: string }[]>(
    "attendance_statuses",
    supabase.from("attendance_statuses").select("id, code")
  );
  const statusId = Object.fromEntries(statuses.map((s) => [s.code, s.id])) as Record<string, string>;

  const absenceTypes = await must<{ id: string; code: string }[]>(
    "absence_types",
    supabase.from("absence_types").select("id, code")
  );
  const absenceTypeId = Object.fromEntries(absenceTypes.map((a) => [a.code, a.id])) as Record<string, string>;

  const lateArrivalPolicies = await must<{ id: string; employee_group_id: string; day_of_week: number }[]>(
    "late_arrival_policies",
    supabase.from("late_arrival_policies").select("id, employee_group_id, day_of_week").is("effective_to", null)
  );
  const overtimePolicies = await must<{ id: string; employee_group_id: string; day_of_week: number; overtime_eligible: boolean }[]>(
    "overtime_policies",
    supabase.from("overtime_policies").select("id, employee_group_id, day_of_week, overtime_eligible").is("effective_to", null)
  );
  const overtimeTypes = await must<{ id: string; code: string }[]>(
    "overtime_types",
    supabase.from("overtime_types").select("id, code")
  );
  const overtimeTypeId = Object.fromEntries(overtimeTypes.map((t) => [t.code, t.id])) as Record<string, string>;

  const approver = await must<{ id: string }[]>(
    "profiles (aprobador demo)",
    supabase.from("profiles").select("id").eq("role", "SUPER_ADMIN").limit(1)
  );
  const approverId = approver[0]?.id;
  if (!approverId) throw new Error("No se encontró ningún profile SUPER_ADMIN en staging para usar como aprobador de las decisiones demo.");

  function lateArrivalPolicyFor(group: string, dateIso: string): string {
    const dow = dayOfWeekIso(dateIso) % 7; // late_arrival_policies usa 0..6 con la misma convención que el resto del esquema
    const row = lateArrivalPolicies.find((p) => p.employee_group_id === groupId[group as keyof typeof groupId] && p.day_of_week === dow);
    if (!row) throw new Error(`No hay late_arrival_policy para ${group} día ${dow}`);
    return row.id;
  }
  function overtimePolicyFor(group: string, dateIso: string): string {
    const dow = dayOfWeekIso(dateIso) % 7;
    const row = overtimePolicies.find((p) => p.employee_group_id === groupId[group as keyof typeof groupId] && p.day_of_week === dow);
    if (!row) throw new Error(`No hay overtime_policy para ${group} día ${dow}`);
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // 1) Empleados demo (upsert por external_workera_id -- reejecutar el script no duplica).
  type DemoEmployee = { code: string; displayName: string; group: keyof typeof groupId; firstName: string; lastName: string };
  const demoEmployees: DemoEmployee[] = [
    { code: "DEMO-PROD-01", displayName: "Demo Producción 01", group: "PRODUCTION", firstName: "Demo", lastName: "Producción 01" },
    { code: "DEMO-PROD-02", displayName: "Demo Producción 02", group: "PRODUCTION", firstName: "Demo", lastName: "Producción 02" },
    { code: "DEMO-PROD-03", displayName: "Demo Producción 03", group: "PRODUCTION", firstName: "Demo", lastName: "Producción 03" },
    { code: "DEMO-PROD-04", displayName: "Demo Producción 04", group: "PRODUCTION", firstName: "Demo", lastName: "Producción 04" },
    { code: "DEMO-INST-01", displayName: "Demo Instalación 01", group: "INSTALLATION", firstName: "Demo", lastName: "Instalación 01" },
    { code: "DEMO-INST-02", displayName: "Demo Instalación 02", group: "INSTALLATION", firstName: "Demo", lastName: "Instalación 02" },
    { code: "DEMO-ADM-01", displayName: "Demo Administración 01", group: "ADMINISTRATION", firstName: "Demo", lastName: "Administración 01" },
    { code: "DEMO-ADM-02", displayName: "Demo Administración 02", group: "ADMINISTRATION", firstName: "Demo", lastName: "Administración 02" },
  ];

  const employeeIds: Record<string, string> = {};
  for (const emp of demoEmployees) {
    const row = await must<{ id: string }[]>(
      `upsert employee ${emp.code}`,
      supabase
        .from("employees")
        .upsert(
          {
            external_workera_id: emp.code,
            first_name: emp.firstName,
            last_name: emp.lastName,
            display_name: emp.displayName,
            employee_group_id: groupId[emp.group],
            source: "demo",
            active: true,
          },
          { onConflict: "external_workera_id" }
        )
        .select("id")
    );
    employeeIds[emp.code] = row[0].id;

    const existingAssignment = await must<{ id: string }[]>(
      `schedule_assignment lookup ${emp.code}`,
      supabase.from("schedule_assignments").select("id").eq("employee_id", row[0].id).eq("effective_from", "2026-08-01")
    );
    if (existingAssignment.length === 0) {
      await must(
        `schedule_assignment ${emp.code}`,
        supabase.from("schedule_assignments").insert({ employee_id: row[0].id, work_schedule_id: STANDARD_SCHEDULE_ID, effective_from: "2026-08-01" })
      );
    }
  }
  console.log(`OK: ${demoEmployees.length} empleados demo creados/actualizados.`);

  // ---------------------------------------------------------------------------
  // 2) Asistencia base: TODOS los días, TODOS los empleados marcan normal salvo
  // donde el caso específico lo sobreescribe abajo. attendance_status_records
  // en 'P' para cada día -- no existe todavía un poblador automático para P/F
  // (confirmado: solo 'L' vía approve_medical_license), así que se inserta
  // directamente, mismo criterio que esa función usa para 'L'.
  async function insertAttendance(empCode: string, dateIso: string, clockInTime: string, clockOutTime: string) {
    const empId = employeeIds[empCode];
    const row = await must<{ id: string }[]>(
      `attendance_record ${empCode} ${dateIso}`,
      supabase
        .from("attendance_records")
        .insert({
          employee_id: empId,
          work_date: dateIso,
          actual_clock_in: `${dateIso}T${clockInTime}-04:00`,
          actual_clock_out: `${dateIso}T${clockOutTime}-04:00`,
          source: "manual",
          source_hash: sourceHash(empCode, dateIso, clockInTime, clockOutTime),
        })
        .select("id")
    );
    return row[0].id;
  }

  async function setStatus(empCode: string, dateIso: string, code: string, reason: string) {
    await must(
      `attendance_status_record ${empCode} ${dateIso} ${code}`,
      supabase.from("attendance_status_records").insert({
        employee_id: employeeIds[empCode],
        work_date: dateIso,
        attendance_status_id: statusId[code],
        source: "manual",
        source_hash: sourceHash(empCode, dateIso, code),
        created_by: approverId,
        reason,
      })
    );
  }

  // 2a) DEMO-PROD-01 -- asistencia perfecta las 10 jornadas.
  for (const day of ALL_DAYS) {
    const sched = scheduledTimesFor(day);
    await insertAttendance("DEMO-PROD-01", day, sched.start, sched.end);
    await setStatus("DEMO-PROD-01", day, "P", "Asistencia normal (demo -- caso perfecto).");
  }
  console.log("OK: DEMO-PROD-01 (asistencia perfecta).");

  // 2b) DEMO-PROD-02 -- dos atrasos: ~8 min (día 1, con decisión ya tomada =
  // resuelto) y ~23 min (día 2, SIN decisión = requiere revisión). El resto de
  // días, normal.
  for (const day of ALL_DAYS) {
    const sched = scheduledTimesFor(day);
    if (day === WEEK1[0]) {
      await insertAttendance("DEMO-PROD-02", day, "07:38:00", sched.end); // 8 min tarde
    } else if (day === WEEK1[1]) {
      await insertAttendance("DEMO-PROD-02", day, "07:53:00", sched.end); // 23 min tarde
    } else {
      await insertAttendance("DEMO-PROD-02", day, sched.start, sched.end);
      await setStatus("DEMO-PROD-02", day, "P", "Asistencia normal.");
    }
  }
  {
    const rec1 = await must<{ id: string }[]>(
      "late_arrival_record día1 PROD-02",
      supabase
        .from("late_arrival_records")
        .insert({
          employee_id: employeeIds["DEMO-PROD-02"],
          work_date: WEEK1[0],
          attendance_record_id: (await must<{ id: string }[]>("attendance day1", supabase.from("attendance_records").select("id").eq("employee_id", employeeIds["DEMO-PROD-02"]).eq("work_date", WEEK1[0])))[0].id,
          scheduled_start: "07:30:00",
          actual_start: `${WEEK1[0]}T07:38:00-04:00`,
          detected_minutes: 8,
          late_arrival_policy_id: lateArrivalPolicyFor("PRODUCTION", WEEK1[0]),
        })
        .select("id")
    );
    await must(
      "late_arrival_decision día1 PROD-02 (resuelto)",
      supabase.from("late_arrival_decisions").insert({
        late_arrival_record_id: rec1[0].id,
        justified: true,
        payroll_minutes: 0,
        payroll_effect: "DO_NOT_DEDUCT",
        reason: "Atraso justificado (demo) -- tráfico informado con anticipación.",
        decided_by: approverId,
      })
    );
    await setStatus("DEMO-PROD-02", WEEK1[0], "P", "Atraso justificado, no afecta el día.");

    await must(
      "late_arrival_record día2 PROD-02 (sin decisión)",
      supabase.from("late_arrival_records").insert({
        employee_id: employeeIds["DEMO-PROD-02"],
        work_date: WEEK1[1],
        attendance_record_id: (await must<{ id: string }[]>("attendance day2", supabase.from("attendance_records").select("id").eq("employee_id", employeeIds["DEMO-PROD-02"]).eq("work_date", WEEK1[1])))[0].id,
        scheduled_start: "07:30:00",
        actual_start: `${WEEK1[1]}T07:53:00-04:00`,
        detected_minutes: 23,
        late_arrival_policy_id: lateArrivalPolicyFor("PRODUCTION", WEEK1[1]),
      })
    );
    // Día 2: sin decisión -> queda '?' (sin estado final resuelto) y aparece como pendiente en Asistencia Actualizada.
  }
  console.log("OK: DEMO-PROD-02 (atrasos: uno resuelto, uno pendiente de revisión).");

  // 2c) DEMO-PROD-03 -- licencia médica: una APROBADA (genera L real vía la
  // misma forma que approve_medical_license) y una PENDIENTE_RRHH (sin L final).
  for (const day of ALL_DAYS) {
    if (day >= WEEK1[0] && day <= WEEK1[2]) continue; // 3 días de licencia aprobada (semana 1, lun-mié)
    if (day === WEEK2[0]) continue; // 1 día de licencia pendiente (semana 2, lunes)
    const sched = scheduledTimesFor(day);
    await insertAttendance("DEMO-PROD-03", day, sched.start, sched.end);
    await setStatus("DEMO-PROD-03", day, "P", "Asistencia normal.");
  }
  {
    // Licencia APROBADA: mismo resultado final que approve_medical_license -- absence_record (MEDICAL_LEAVE) +
    // medical_license_approvals(status=APPROVED) + attendance_status_records(code=L) para cada día del rango.
    const approvedAbsence = await must<{ id: string }[]>(
      "absence_record licencia aprobada PROD-03",
      supabase
        .from("absence_records")
        .insert({
          employee_id: employeeIds["DEMO-PROD-03"],
          absence_type_id: absenceTypeId["MEDICAL_LEAVE"],
          start_date: WEEK1[0],
          end_date: WEEK1[2],
          source: "manual",
          created_by: approverId,
          source_hash: sourceHash("DEMO-PROD-03", "medical-approved"),
        })
        .select("id")
    );
    const approvedDoc = await must<{ id: string }[]>(
      "supporting_document licencia aprobada PROD-03",
      supabase
        .from("supporting_documents")
        .insert({
          employee_id: employeeIds["DEMO-PROD-03"],
          absence_record_id: approvedAbsence[0].id,
          document_type: "MEDICAL_CERTIFICATE",
          storage_path: `demo/DEMO-PROD-03/licencia-aprobada-${WEEK1[0]}.pdf`,
          mime_type: "application/pdf",
          original_filename: "licencia-medica-demo.pdf",
          uploaded_by: approverId,
        })
        .select("id")
    );
    await must(
      "medical_license_approvals aprobada PROD-03",
      supabase.from("medical_license_approvals").insert({
        absence_record_id: approvedAbsence[0].id,
        supporting_document_id: approvedDoc[0].id,
        status: "APPROVED",
        proposed_start_date: WEEK1[0],
        proposed_end_date: WEEK1[2],
        confirmed_start_date: WEEK1[0],
        confirmed_end_date: WEEK1[2],
        uploaded_by: approverId,
        approved_by: approverId,
        approved_at: new Date().toISOString(),
      })
    );
    for (const day of [WEEK1[0], WEEK1[1], WEEK1[2]]) {
      await setStatus("DEMO-PROD-03", day, "L", "Licencia médica aprobada (demo).");
    }

    // Licencia PENDIENTE: absence_record + medical_license_approvals(status=PENDING_RRHH_APPROVAL), SIN L.
    const pendingAbsence = await must<{ id: string }[]>(
      "absence_record licencia pendiente PROD-03",
      supabase
        .from("absence_records")
        .insert({
          employee_id: employeeIds["DEMO-PROD-03"],
          absence_type_id: absenceTypeId["MEDICAL_LEAVE"],
          start_date: WEEK2[0],
          end_date: WEEK2[0],
          source: "manual",
          created_by: approverId,
          source_hash: sourceHash("DEMO-PROD-03", "medical-pending"),
        })
        .select("id")
    );
    const pendingDoc = await must<{ id: string }[]>(
      "supporting_document licencia pendiente PROD-03",
      supabase
        .from("supporting_documents")
        .insert({
          employee_id: employeeIds["DEMO-PROD-03"],
          absence_record_id: pendingAbsence[0].id,
          document_type: "MEDICAL_CERTIFICATE",
          storage_path: `demo/DEMO-PROD-03/licencia-pendiente-${WEEK2[0]}.pdf`,
          mime_type: "application/pdf",
          original_filename: "licencia-medica-demo.pdf",
          uploaded_by: approverId,
        })
        .select("id")
    );
    await must(
      "medical_license_approvals pendiente PROD-03",
      supabase.from("medical_license_approvals").insert({
        absence_record_id: pendingAbsence[0].id,
        supporting_document_id: pendingDoc[0].id,
        status: "PENDING_RRHH_APPROVAL",
        proposed_start_date: WEEK2[0],
        proposed_end_date: WEEK2[0],
        uploaded_by: approverId,
      })
    );
    // WEEK2[0]: sin attendance_status_record -- sin L hasta que se apruebe, exactamente el comportamiento ya verificado.
  }
  console.log("OK: DEMO-PROD-03 (licencia médica: una aprobada -> L, una pendiente -> sin L).");

  // 2d) DEMO-PROD-04 -- horas extra: una candidata APROBADA, una PENDIENTE.
  for (const day of ALL_DAYS) {
    const sched = scheduledTimesFor(day);
    if (day === WEEK1[3]) {
      await insertAttendance("DEMO-PROD-04", day, sched.start, "19:00:00"); // 2h extra, semana 1 -- aprobadas
    } else if (day === WEEK2[3]) {
      await insertAttendance("DEMO-PROD-04", day, sched.start, "19:30:00"); // 2.5h extra, semana 2 -- pendientes
    } else {
      await insertAttendance("DEMO-PROD-04", day, sched.start, sched.end);
      await setStatus("DEMO-PROD-04", day, "P", "Asistencia normal.");
    }
  }
  {
    const attApproved = await must<{ id: string }[]>("attendance OT aprobado", supabase.from("attendance_records").select("id").eq("employee_id", employeeIds["DEMO-PROD-04"]).eq("work_date", WEEK1[3]));
    const otApproved = await must<{ id: string }[]>(
      "overtime_record aprobado PROD-04",
      supabase
        .from("overtime_records")
        .insert({
          employee_id: employeeIds["DEMO-PROD-04"],
          work_date: WEEK1[3],
          attendance_record_id: attApproved[0].id,
          overtime_type_id: overtimeTypeId["OVERTIME_50"],
          candidate_minutes: 120,
          overtime_policy_id: overtimePolicyFor("PRODUCTION", WEEK1[3]),
        })
        .select("id")
    );
    await must(
      "overtime_decision aprobada PROD-04",
      supabase.from("overtime_decisions").insert({
        overtime_record_id: otApproved[0].id,
        approved_minutes: 120,
        rejected_minutes: 0,
        decision_status: "FULLY_APPROVED",
        reason: "Cierre de turno con pedido urgente (demo).",
        decided_by: approverId,
      })
    );
    await setStatus("DEMO-PROD-04", WEEK1[3], "P", "Día con horas extra aprobadas.");

    const attPending = await must<{ id: string }[]>("attendance OT pendiente", supabase.from("attendance_records").select("id").eq("employee_id", employeeIds["DEMO-PROD-04"]).eq("work_date", WEEK2[3]));
    await must(
      "overtime_record pendiente PROD-04",
      supabase.from("overtime_records").insert({
        employee_id: employeeIds["DEMO-PROD-04"],
        work_date: WEEK2[3],
        attendance_record_id: attPending[0].id,
        overtime_type_id: overtimeTypeId["OVERTIME_50"],
        candidate_minutes: 150,
        overtime_policy_id: overtimePolicyFor("PRODUCTION", WEEK2[3]),
      })
    );
    // Sin decisión -> pendiente de aprobar, aparece en Pendientes.
  }
  console.log("OK: DEMO-PROD-04 (horas extra: una aprobada, una pendiente).");

  // 2e) DEMO-INST-01 -- salida anticipada sin decisión (requiere revisión).
  for (const day of ALL_DAYS) {
    const sched = scheduledTimesFor(day);
    if (day === WEEK1[2]) {
      await insertAttendance("DEMO-INST-01", day, sched.start, "15:30:00"); // sale 1.5h antes (jornada normal termina 17:00)
    } else {
      await insertAttendance("DEMO-INST-01", day, sched.start, sched.end);
      await setStatus("DEMO-INST-01", day, "P", "Asistencia normal.");
    }
  }
  {
    const attEarly = await must<{ id: string }[]>("attendance salida anticipada", supabase.from("attendance_records").select("id").eq("employee_id", employeeIds["DEMO-INST-01"]).eq("work_date", WEEK1[2]));
    await must(
      "early_departure_record INST-01",
      supabase.from("early_departure_records").insert({
        employee_id: employeeIds["DEMO-INST-01"],
        work_date: WEEK1[2],
        attendance_record_id: attEarly[0].id,
        scheduled_end: "17:00:00",
        actual_end: `${WEEK1[2]}T15:30:00-04:00`,
        detected_minutes: 90,
      })
    );
    // Sin decisión -> requiere revisión (categoría EARLY_DEPARTURE del motor de revisión diaria).
  }
  console.log("OK: DEMO-INST-01 (salida anticipada pendiente de revisión).");

  // 2f) DEMO-INST-02 -- ausencia: una justificada (CONFIRMED), una sin resolver.
  for (const day of ALL_DAYS) {
    if (day === WEEK1[4] || day === WEEK2[4]) continue; // ausente esos 2 días
    const sched = scheduledTimesFor(day);
    await insertAttendance("DEMO-INST-02", day, sched.start, sched.end);
    await setStatus("DEMO-INST-02", day, "P", "Asistencia normal.");
  }
  {
    const justifiedAbsence = await must<{ id: string }[]>(
      "absence_record justificada INST-02",
      supabase
        .from("absence_records")
        .insert({
          employee_id: employeeIds["DEMO-INST-02"],
          absence_type_id: absenceTypeId["PERMISSION"],
          start_date: WEEK1[4],
          end_date: WEEK1[4],
          source: "manual",
          created_by: approverId,
          source_hash: sourceHash("DEMO-INST-02", "absence-justified"),
        })
        .select("id")
    );
    await must(
      "absence_decision justificada INST-02",
      supabase.from("absence_decisions").insert({
        absence_record_id: justifiedAbsence[0].id,
        decision_status: "CONFIRMED",
        reason: "Permiso administrativo justificado (demo).",
        decided_by: approverId,
      })
    );
    await setStatus("DEMO-INST-02", WEEK1[4], "F-J", "Falta justificada (demo).");

    await must(
      "absence_record sin resolver INST-02",
      supabase.from("absence_records").insert({
        employee_id: employeeIds["DEMO-INST-02"],
        absence_type_id: absenceTypeId["PERMISSION"],
        start_date: WEEK2[4],
        end_date: WEEK2[4],
        source: "manual",
          created_by: approverId,
        source_hash: sourceHash("DEMO-INST-02", "absence-unresolved"),
      })
    );
    // Sin decisión -> ausencia sin resolver, aparece en Pendientes.
  }
  console.log("OK: DEMO-INST-02 (ausencia: una justificada, una sin resolver).");

  // 2g) DEMO-ADM-01 -- vacaciones: una APROBADA (-> V) y una PENDIENTE.
  for (const day of ALL_DAYS) {
    if (day >= WEEK1[0] && day <= WEEK1[1]) continue; // vacaciones aprobadas, semana 1 lun-mar
    if (day === WEEK2[2]) continue; // vacaciones pendientes, semana 2 miércoles
    const sched = scheduledTimesFor(day);
    await insertAttendance("DEMO-ADM-01", day, sched.start, sched.end);
    await setStatus("DEMO-ADM-01", day, "P", "Asistencia normal.");
  }
  {
    const approvedVacation = await must<{ id: string }[]>(
      "absence_record vacaciones aprobadas ADM-01",
      supabase
        .from("absence_records")
        .insert({
          employee_id: employeeIds["DEMO-ADM-01"],
          absence_type_id: absenceTypeId["VACATION"],
          start_date: WEEK1[0],
          end_date: WEEK1[1],
          source: "manual",
          created_by: approverId,
          source_hash: sourceHash("DEMO-ADM-01", "vacation-approved"),
        })
        .select("id")
    );
    await must(
      "absence_decision vacaciones aprobadas ADM-01",
      supabase.from("absence_decisions").insert({
        absence_record_id: approvedVacation[0].id,
        decision_status: "CONFIRMED",
        reason: "Vacaciones aprobadas (demo).",
        decided_by: approverId,
      })
    );
    for (const day of [WEEK1[0], WEEK1[1]]) {
      await setStatus("DEMO-ADM-01", day, "V", "Vacaciones aprobadas (demo).");
    }

    await must(
      "absence_record vacaciones pendientes ADM-01",
      supabase.from("absence_records").insert({
        employee_id: employeeIds["DEMO-ADM-01"],
        absence_type_id: absenceTypeId["VACATION"],
        start_date: WEEK2[2],
        end_date: WEEK2[2],
        source: "manual",
          created_by: approverId,
        source_hash: sourceHash("DEMO-ADM-01", "vacation-pending"),
      })
    );
    // Sin decisión -> "Falta aprobar vacaciones de Demo Administración 01 por RRHH." en Asistencia Actualizada.
  }
  console.log("OK: DEMO-ADM-01 (vacaciones: una aprobada -> V, una pendiente).");

  // 2h) DEMO-ADM-02 -- relleno, asistencia perfecta (variedad adicional en Administración).
  for (const day of ALL_DAYS) {
    const sched = scheduledTimesFor(day);
    await insertAttendance("DEMO-ADM-02", day, sched.start, sched.end);
    await setStatus("DEMO-ADM-02", day, "P", "Asistencia normal.");
  }
  console.log("OK: DEMO-ADM-02 (asistencia perfecta, relleno de Administración).");

  console.log("\nSembrado completo. 8 empleados demo, 2 semanas laborales completas, todos los tipos de caso requeridos.");
}

main().catch((err) => {
  console.error("FALLÓ el sembrado de datos demo:", err);
  process.exit(1);
});
