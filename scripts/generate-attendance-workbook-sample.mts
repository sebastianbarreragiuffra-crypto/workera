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

const period = {
  type: "PAGO" as const,
  startDate: "2026-07-16",
  endDate: "2026-08-15",
  label: "Remuneraciones agosto de 2026 · 16 de julio al 15 de agosto de 2026",
};
const days = calendarDaysBetween(period.startDate, period.endDate);

function attendanceDay(statusCode = "P", patch: Partial<AttendanceExportDay> = {}): AttendanceExportDay {
  return {
    statusCode,
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
}): AttendanceExportWorker {
  const scheduledDates = new Set(days.filter((date) => !isWeekend(date)));
  const scheduleCoveredDates = new Set(days);
  const exemptDates = input.exempt ? new Set(scheduledDates) : new Set<string>();
  const records = new Map<string, AttendanceExportDay>();
  if (!input.exempt) {
    for (const date of scheduledDates) records.set(date, attendanceDay());
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
  };
}

const maria = worker({
  id: "demo-1",
  code: "WK-001",
  rut: "11111111-1",
  name: "MARÍA GONZÁLEZ",
  area: "ADMINISTRATION",
  costCenter: "CC-ADM — Administración",
  schedule: "L-J 08:30-18:00 · V 08:30-15:50",
});
maria.days.set("2026-07-20", attendanceDay("F"));
maria.days.set("2026-07-27", attendanceDay("V"));
maria.days.set("2026-07-28", attendanceDay("V"));
maria.days.set("2026-07-17", attendanceDay("P", { overtime50Minutes: 120, bonusAmount: 1_000 }));
maria.days.set("2026-07-21", attendanceDay("P", { lateDetectedMinutes: 12, lateMinutes: 12, bonusAmount: 1_000 }));

const juan = worker({
  id: "demo-2",
  code: "WK-002",
  rut: "22222222-2",
  name: "JUAN PÉREZ",
  area: "PRODUCTION",
  costCenter: "CC-PROD — Producción",
  schedule: "L-J 08:00-17:30 · V 08:00-15:20",
});
for (const date of ["2026-08-03", "2026-08-04", "2026-08-05"]) juan.days.set(date, attendanceDay("L"));
juan.days.set("2026-08-09", attendanceDay("P", { overtime100Minutes: 180 }));

const carla = worker({
  id: "demo-3",
  code: "WK-003",
  rut: "33333333-3",
  name: "CARLA SOTO",
  area: "INSTALLATION",
  costCenter: "CC-INST — Instalaciones",
  schedule: "L-V 08:00-17:00",
});
carla.days.set("2026-08-10", attendanceDay("P", { missingPunchPending: true }));

const diego = worker({
  id: "demo-4",
  code: "WK-004",
  rut: "44444444-4",
  name: "DIEGO PÉREZ",
  area: "ADMINISTRATION",
  costCenter: "CC-ADM — Administración",
  schedule: "Exento de marcación",
  exempt: true,
});

const data: AttendanceExportData = {
  period,
  days,
  workers: [carla, diego, juan, maria],
  holidays: new Set<string>(),
  reportingPeriodStatus: "CLOSED",
  ruleEngineProblemDates: new Set<string>(),
};

const outputPath = resolve(process.argv[2] ?? "output/muestra-pre-nomina-2026.xlsx");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildAttendanceExportWorkbook(data));
console.log(outputPath);
