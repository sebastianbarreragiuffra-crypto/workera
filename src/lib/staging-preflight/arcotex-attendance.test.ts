import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArcotexAttendancePilotReport,
  completedWeekCandidates,
  renderArcotexAttendancePilotReport,
  selectLatestFullyCollectedWeek,
  type ArcotexAttendancePilotCollection,
  type AttendancePilotDayObservation,
  type SyncRunCoverage,
} from "./arcotex-attendance";

function succeededDays(start = "2026-08-24"): AttendancePilotDayObservation[] {
  const startDate = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(startDate);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      successfulSyncRuns: 1,
      rawEvents: index < 6 ? 10 : 0,
      attendanceRecords: index < 5 ? 8 : 0,
      ruleEngine: {
        status: "SUCCEEDED",
        employeesProcessed: 8,
        attendanceDerived: index < 5 ? 8 : 0,
        lateCandidates: 1,
        earlyDepartureCandidates: 0,
        overtimeCandidates: 1,
        withoutSchedule: 0,
        failureCount: 0,
      },
    };
  });
}

function collectedWeek(days = succeededDays()): ArcotexAttendancePilotCollection {
  return {
    kind: "COLLECTED_WEEK",
    activeEmployees: 8,
    selectedWeek: { start: "2026-08-24", end: "2026-08-30" },
    skippedNewerIncompleteWeeks: 1,
    days,
    reviewQueue: {
      lateArrivals: { total: 5, pending: 2 },
      earlyDepartures: { total: 1, pending: 1 },
      overtime: { total: 4, pending: 3 },
      absences: { total: 2, pending: 0 },
      missingPunchesPending: 2,
    },
  };
}

test("calcula semanas cerradas lunes-domingo en la zona de ARCOTEX", () => {
  const weeks = completedWeekCandidates(new Date("2026-09-07T12:00:00.000Z"), "America/Santiago", 2);
  assert.deepEqual(weeks, [
    { start: "2026-08-31", end: "2026-09-06" },
    { start: "2026-08-24", end: "2026-08-30" },
  ]);
});

test("elige la última semana completamente sincronizada y omite una semana parcial más nueva", () => {
  const candidates = completedWeekCandidates(new Date("2026-09-07T12:00:00.000Z"), "America/Santiago", 2);
  const runs: SyncRunCoverage[] = [
    { startDate: "2026-08-31", endDate: "2026-09-01", startedAt: "2026-09-02T10:00:00Z", status: "SUCCEEDED" },
    { startDate: "2026-08-24", endDate: "2026-08-30", startedAt: "2026-08-31T10:00:00Z", status: "SUCCEEDED" },
  ];
  assert.deepEqual(selectLatestFullyCollectedWeek(candidates, runs), {
    range: { start: "2026-08-24", end: "2026-08-30" },
    skippedNewerIncompleteWeeks: 1,
  });
});

test("una corrida posterior fallida invalida la cobertura aunque antes hubiera una exitosa", () => {
  const candidates = [{ start: "2026-08-24", end: "2026-08-30" }];
  const runs: SyncRunCoverage[] = [
    { startDate: "2026-08-24", endDate: "2026-08-30", startedAt: "2026-08-31T10:00:00Z", status: "SUCCEEDED" },
    { startDate: "2026-08-27", endDate: "2026-08-27", startedAt: "2026-09-01T10:00:00Z", status: "FAILED" },
  ];
  assert.equal(selectLatestFullyCollectedWeek(candidates, runs), null);
});

test("un motor parcial bloquea la revisión en sombra aunque la asistencia ya esté recolectada", () => {
  const days = succeededDays();
  days[2] = { ...days[2], ruleEngine: { ...days[2].ruleEngine, status: "PARTIAL", failureCount: 3 } };
  const report = buildArcotexAttendancePilotReport(collectedWeek(days), "2026-09-07T12:00:00.000Z");
  assert.equal(report.outcome, "RULE_ENGINE_INCOMPLETE");
  assert.equal(report.totals?.ruleEngineSucceededDays, 6);
  assert.equal(report.totals?.ruleEngineFailureCount, 3);
  assert.equal(report.totals?.pendingHumanReview, 8);
});

test("una semana recolectada y procesada queda lista sólo para revisión humana en sombra", () => {
  const report = buildArcotexAttendancePilotReport(collectedWeek(), "2026-09-07T12:00:00.000Z");
  assert.equal(report.outcome, "READY_FOR_SHADOW_REVIEW");
  assert.equal(report.selectedWeek?.start, "2026-08-24");
  assert.match(report.constraints.join(" "), /decisión sigue siendo humana/i);
  assert.match(report.constraints.join(" "), /No enviar resultados a remuneraciones/i);
});

test("si ninguna semana tiene siete días sincronizados el preflight falla cerrado", () => {
  const report = buildArcotexAttendancePilotReport({
    kind: "NO_COMPLETE_WEEK",
    activeEmployees: 98,
    latestCompletedWeek: { start: "2026-08-31", end: "2026-09-06" },
    latestWeekSuccessfulSyncDays: 2,
    searchedWeeks: 8,
  });
  assert.equal(report.outcome, "NO_COMPLETE_COLLECTED_WEEK");
  assert.match(report.note, /2\/7 días sincronizados/);
});

test("el reporte renderizado contiene sólo fechas, conteos y estados agregados", () => {
  const rendered = renderArcotexAttendancePilotReport(buildArcotexAttendancePilotReport(collectedWeek()));
  for (const forbidden of ["display_name", "first_name", "last_name", "rut", "email", "employee_id", "company_id", "service_role"] ) {
    assert.doesNotMatch(rendered, new RegExp(forbidden, "i"));
  }
});
