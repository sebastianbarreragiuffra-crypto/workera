import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  isWeekend,
  type AttendanceExportData,
  type AttendanceExportDay,
  type AttendanceExportWorker,
} from "../src/lib/business-rules/attendance-export";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../src/lib/tenant/legacy-workforce";

const period = {
  type: "PAGO" as const,
  startDate: "2026-07-16",
  endDate: "2026-08-15",
  label: "Remuneraciones agosto de 2026 · 16 de julio al 15 de agosto de 2026",
};
const days = calendarDaysBetween(period.startDate, period.endDate);
const fictitiousEmployeeId = (index: number): string =>
  `f1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function attendanceDay(statusCode = "P", patch: Partial<AttendanceExportDay> = {}): AttendanceExportDay {
  return {
    statusCode,
    recordedMinutes: statusCode === "P" ? 540 : 0,
    lateDetectedMinutes: 0,
    lateMinutes: 0,
    earlyDepartureDetectedMinutes: 0,
    earlyDepartureMinutes: 0,
    overtime50Minutes: 0,
    overtime100Minutes: 0,
    overtime50CandidateMinutes: 0,
    overtime100CandidateMinutes: 0,
    bonusAmount: 0,
    lateDecisionPending: false,
    earlyDepartureDecisionPending: false,
    overtime50DecisionPending: false,
    overtime100DecisionPending: false,
    missingPunchPending: false,
    absenceDecisionPending: false,
    ...patch,
  };
}

function worker(input: {
  id: string;
  code: string;
  rut: string;
  name: string;
  area: AttendanceExportWorker["area"];
  schedule: string;
  costCenter: string;
  exempt?: boolean;
  weekdayRecordedMinutes?: Partial<Record<number, number>>;
  scheduleConfirmationPending?: boolean;
}): AttendanceExportWorker {
  const scheduledDates = new Set(days.filter((date) => !isWeekend(date) && date !== "2026-07-16"));
  const scheduleCoveredDates = new Set(days);
  const exemptDates = input.exempt ? new Set(scheduledDates) : new Set<string>();
  const records = new Map<string, AttendanceExportDay>();
  if (!input.exempt) {
    for (const date of scheduledDates) {
      const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
      records.set(date, attendanceDay("P", {
        recordedMinutes: input.weekdayRecordedMinutes?.[dayOfWeek] ?? 540,
      }));
    }
  }
  return {
    employeeId: input.id,
    employeeCode: input.code,
    employeeRut: input.rut,
    workerName: input.name,
    area: input.area,
    costCenter: input.costCenter,
    days: records,
    hireDate: null,
    currentlyActive: true,
    scheduledWeekdays: new Set([1, 2, 3, 4, 5]),
    scheduleCoveredDates,
    scheduledDates,
    exemptDates,
    scheduleLabel: input.schedule,
    scheduleConfirmationPending: input.scheduleConfirmationPending ?? false,
  };
}

const maria = worker({
  id: fictitiousEmployeeId(1),
  code: "WK-001",
  rut: "11111111-1",
  name: "MARÍA GONZÁLEZ",
  area: "ADMINISTRATION",
  costCenter: "CC-ADM — Administración",
  schedule: "L-J 08:30-18:00 · V 08:30-15:50",
  weekdayRecordedMinutes: { 1: 570, 2: 570, 3: 570, 4: 570, 5: 440 },
  scheduleConfirmationPending: true,
});
maria.days.set("2026-07-20", attendanceDay("F"));
maria.days.set("2026-07-27", attendanceDay("V"));
maria.days.set("2026-07-28", attendanceDay("V"));
maria.days.set("2026-07-21", attendanceDay("P", {
  recordedMinutes: 570,
  lateDetectedMinutes: 12,
  lateMinutes: 12,
  lateDecisionAudit: {
    decision: "DESCONTAR",
    reason: "Decisión ficticia para inspección visual",
    responsible: "SUPERVISORA FICTICIA",
    decidedAt: "2026-09-06T12:00:00.000Z",
  },
}));

const juan = worker({
  id: fictitiousEmployeeId(2),
  code: "WK-002",
  rut: "22222222-2",
  name: "JUAN PÉREZ",
  area: "PRODUCTION",
  costCenter: "CC-PROD — Producción",
  schedule: "L-J 08:00-17:30 · V 08:00-15:20",
  weekdayRecordedMinutes: { 1: 570, 2: 570, 3: 570, 4: 570, 5: 440 },
  scheduleConfirmationPending: true,
});
for (const date of ["2026-08-03", "2026-08-04", "2026-08-05"]) juan.days.set(date, attendanceDay("L"));
juan.days.set("2026-08-09", attendanceDay("P", {
  recordedMinutes: 180,
  overtime100CandidateMinutes: 180,
  overtime100DecisionPending: true,
}));

const carla = worker({
  id: fictitiousEmployeeId(3),
  code: "WK-003",
  rut: "33333333-3",
  name: "CARLA SOTO",
  area: "INSTALLATION",
  costCenter: "CC-INST — Instalaciones",
  schedule: "L-V 08:00-17:00",
});
carla.days.set("2026-08-10", attendanceDay("P", { missingPunchPending: true }));
carla.days.set("2026-08-09", attendanceDay("P", {
  recordedMinutes: 600,
  overtime100CandidateMinutes: 600,
  overtime100Minutes: 600,
  bonusAmount: 1_000,
}));

const diego = worker({
  id: fictitiousEmployeeId(4),
  code: "WK-004",
  rut: "44444444-4",
  name: "DIEGO PÉREZ",
  area: "ADMINISTRATION",
  costCenter: "CC-ADM — Administración",
  schedule: "Exento de marcación",
  exempt: true,
});

const simulatedWorkers: AttendanceExportWorker[] = [];
for (let index = 5; index <= 55; index += 1) {
  const area = index % 3 === 0 ? "INSTALLATION" : index % 3 === 1 ? "PRODUCTION" : "ADMINISTRATION";
  simulatedWorkers.push(worker({
    id: fictitiousEmployeeId(index),
    code: `SIM-${String(index).padStart(3, "0")}`,
    rut: `FICTICIO-${String(index).padStart(3, "0")}`,
    name: `PERSONA SIMULADA ${String(index).padStart(2, "0")}`,
    area,
    costCenter: area === "PRODUCTION" ? "CC-PROD — Producción" : area === "INSTALLATION" ? "CC-INST — Instalaciones" : "CC-ADM — Administración",
    schedule: "L-V 08:00-17:00",
  }));
}

// Incidencias ficticias representativas para validar lectura visual con 55 filas.
// Las horas extra se asignan sólo a Producción/Instalaciones y Producción en
// domingo queda como observación real pendiente, nunca como pago.
simulatedWorkers[1].days.set("2026-07-18", attendanceDay("P", {
  recordedMinutes: 539,
  overtime50CandidateMinutes: 59,
  overtime50DecisionPending: true,
}));
simulatedWorkers[2].days.set("2026-07-25", attendanceDay("P", {
  recordedMinutes: 660,
  overtime50CandidateMinutes: 120,
  overtime50Minutes: 120,
  bonusAmount: 1_000,
}));
simulatedWorkers[3].days.set("2026-08-03", attendanceDay("F-P"));
simulatedWorkers[4].days.set("2026-08-04", attendanceDay("F-J"));
simulatedWorkers[5].days.set("2026-08-05", attendanceDay("P-L"));
simulatedWorkers[6].days.set("2026-08-06", attendanceDay("P-M"));
simulatedWorkers[7].days.set("2026-08-07", attendanceDay("L-M"));
simulatedWorkers[8].days.set("2026-08-10", attendanceDay("P", { earlyDepartureDetectedMinutes: 25, earlyDepartureDecisionPending: true }));
simulatedWorkers[9].days.set("2026-08-11", attendanceDay("?", { missingPunchPending: true }));

const data: AttendanceExportData = {
  period,
  days,
  workers: [carla, diego, juan, maria, ...simulatedWorkers],
  holidays: new Set<string>(["2026-07-16"]),
  reportingPeriodStatus: "IN_REVIEW",
  ruleEngineProblemDates: new Set<string>(),
  companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
  workbookBaseVersionId: null,
};

const outputPath = resolve(process.argv[2] ?? "output/muestra-pre-nomina-2026.xlsx");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildAttendanceExportWorkbook(data));
console.log(outputPath);
