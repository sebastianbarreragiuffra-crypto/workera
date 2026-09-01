import type { DailyReviewDetailViewModel } from "../../../lib/view-models/daily-review-view";
import type { AreaCode } from "../../../lib/access/scope";
import { formatCalendarDate, formatInstantInSantiago, formatTimeInSantiago } from "../../../lib/view-models/date-utils";
import Link from "next/link";
import { DayTimeline } from "./DayTimeline";
import { DecisionBadge } from "./StatusBadge";
import {
  decideLateArrivalAction,
  decideOvertimeAction,
  markEarlyDepartureMedicalAction,
  confirmEarlyDepartureMedicalDocumentAction,
  decideEarlyDepartureOtherAction,
  markAbsencePendingDocumentAction,
  confirmAbsenceDocumentAction,
  disputeAbsenceAction,
  uploadDocumentAction,
} from "./actions";

function formatTime(value: string | null): string {
  if (!value) return "—";
  return formatTimeInSantiago(value);
}

function formatDecidedAt(value: string): string {
  return formatInstantInSantiago(value, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function HiddenContext({ employeeId, date, area }: { employeeId: string; date: string; area: AreaCode }) {
  return (
    <>
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="area" value={area} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-4 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

const PRIMARY_BTN = "rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark";
const SECONDARY_BTN = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";
const UPLOAD_BTN = "rounded-md bg-arcotex-copper px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-arcotex-copper-dark";
const UPLOAD_INPUT = "w-full rounded-md border border-arcotex-copper-border bg-arcotex-copper-light p-1.5 text-xs text-slate-600 file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-arcotex-copper file:px-2 file:py-1 file:font-semibold file:text-white hover:file:bg-arcotex-copper-dark";
const DANGER_BTN = "rounded-md border border-critical-border px-3 py-1.5 text-sm font-medium text-critical hover:bg-critical-bg";

function CommentField() {
  return (
    <div>
      <label htmlFor="reason" className="text-xs font-medium text-slate-500">
        Comentario / Justificación
      </label>
      <textarea
        id="reason"
        name="reason"
        rows={2}
        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
        placeholder="Opcional"
      />
    </div>
  );
}

export function ReviewDetailPanel({
  detail,
  date,
  area,
}: {
  detail: DailyReviewDetailViewModel;
  date: string;
  area: AreaCode;
}) {
  return (
    <aside aria-label={`Detalle de ${detail.displayName}`} className="space-y-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{detail.displayName}</h2>
          {detail.isBirthdayToday && <span className="text-sm font-medium text-pink-600">🎂 Cumpleaños hoy</span>}
        </div>
        <p className="text-xs text-slate-400">
          {detail.timeControl.kind === "EXEMPT" ? "Exento de control horario" : "Control horario normal"}
        </p>
        <Link href={`/empleados/${detail.employeeId}`} className="mt-1 inline-block text-xs font-medium text-arcotex-blue hover:underline">
          Ver ficha completa →
        </Link>
      </div>

      <Section title="Horario y marcaciones">
        <DayTimeline
          events={detail.timeline}
          scheduledStart={detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledStart : undefined}
          scheduledEnd={detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledEnd : undefined}
        />
        {detail.schedule.kind === "DAY_OFF" && <p className="text-sm text-slate-500">Día libre según horario asignado.</p>}
        {detail.schedule.kind === "NO_SCHEDULE_ASSIGNED" && <p className="text-sm text-amber-700">Sin horario asignado.</p>}
        {detail.missingPunch && <p className="text-xs font-medium text-critical">⚠ Marcación faltante</p>}
      </Section>

      {detail.lateArrival && (
        <Section title="Atraso">
          <p className="text-sm text-slate-700">
            Hora esperada: {detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledStart.slice(0, 5) : "—"} · Entrada: {formatTime(detail.clockIn)}
          </p>
          <p className="text-sm text-slate-700">Atraso: {detail.lateArrival.detectedMinutes} minutos</p>
          <p className="text-xs italic text-slate-400">Acumulado semanal: próximamente (sin servicio de agregación confiable todavía).</p>
          {detail.lateArrival.decision ? (
            <div className="space-y-1">
              <DecisionBadge label={detail.lateArrival.decision.justified ? "Justificado" : "No justificado"} tone={detail.lateArrival.decision.justified ? "positive" : "negative"} />
              <p className="text-xs text-slate-500">
                {detail.lateArrival.decision.payrollMinutes} min a liquidación · {formatDecidedAt(detail.lateArrival.decision.decidedAt)}
              </p>
            </div>
          ) : (
            <form action={decideLateArrivalAction} className="space-y-2 pt-1">
              <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
              <input type="hidden" name="lateArrivalRecordId" value={detail.lateArrival.recordId} />
              <CommentField />
              <div className="flex gap-2">
                <button type="submit" name="justified" value="true" className={PRIMARY_BTN}>
                  Justificar
                </button>
                <button type="submit" name="justified" value="false" className={SECONDARY_BTN}>
                  No justificar
                </button>
              </div>
            </form>
          )}
        </Section>
      )}

      {detail.overtime && (
        <Section title="Horas extra">
          <p className="text-sm text-slate-700">
            Salida esperada: {detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledEnd.slice(0, 5) : "—"} · Salida registrada: {formatTime(detail.clockOut)}
          </p>
          <p className="text-sm text-slate-700">Horas extra candidatas: {detail.overtime.candidateMinutes} min</p>
          {detail.overtime.bonusAmount !== null && (
            <p className="text-xs text-slate-500">Bono diario (ya determinado por el motor): ${detail.overtime.bonusAmount.toLocaleString("es-CL")}</p>
          )}
          {detail.overtime.decision ? (
            <div className="space-y-1">
              <DecisionBadge
                label={detail.overtime.decision.status === "FULLY_APPROVED" ? "Aprobado" : detail.overtime.decision.status === "REJECTED" ? "Rechazado" : detail.overtime.decision.status}
                tone={detail.overtime.decision.status === "FULLY_APPROVED" ? "positive" : detail.overtime.decision.status === "REJECTED" ? "negative" : "neutral"}
              />
              <p className="text-xs text-slate-500">
                {detail.overtime.decision.approvedMinutes} min aprobados · {formatDecidedAt(detail.overtime.decision.decidedAt)}
              </p>
            </div>
          ) : (
            <form action={decideOvertimeAction} className="space-y-2 pt-1">
              <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
              <input type="hidden" name="overtimeRecordId" value={detail.overtime.recordId} />
              <CommentField />
              <div className="flex gap-2">
                <button type="submit" name="action" value="APPROVE" className={PRIMARY_BTN}>
                  Aprobar
                </button>
                <button type="submit" name="action" value="REJECT" className={DANGER_BTN}>
                  Rechazar
                </button>
              </div>
            </form>
          )}
        </Section>
      )}

      {detail.missingPunch && !detail.overtime && !detail.lateArrival && (
        <Section title="Clock out pendiente">
          <p className="text-sm text-slate-700">Entrada: {formatTime(detail.clockIn)}</p>
          <p className="text-sm text-slate-700">
            Salida esperada: {detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledEnd.slice(0, 5) : "—"}
          </p>
          <p className="text-sm font-medium text-amber-700">Sin marcación de salida.</p>
          <p className="text-xs text-slate-500">
            Requiere revisión — no existe todavía un flujo de corrección de marcación en el sistema. No se asume ninguna hora de salida.
          </p>
        </Section>
      )}

      {detail.earlyDeparture && (
        <Section title="Salida anticipada">
          <p className="text-sm text-slate-700">
            Salida esperada: {detail.schedule.kind === "SCHEDULED" ? detail.schedule.scheduledEnd.slice(0, 5) : "—"} · Salida: {formatTime(detail.clockOut)}
          </p>
          <p className="text-sm text-slate-700">Salida anticipada: {detail.earlyDeparture.detectedMinutes} minutos</p>
          {detail.earlyDeparture.decision ? (
            <EarlyDepartureDecisionSummary detail={detail} date={date} area={area} />
          ) : (
            <form action={decideEarlyDepartureOtherAction} className="space-y-2 pt-1">
              <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
              <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture.recordId} />
              <p className="text-sm text-slate-700">¿Salida por atención médica?</p>
              <CommentField />
              <div className="flex flex-wrap gap-2">
                <button type="submit" formAction={markEarlyDepartureMedicalAction} className={SECONDARY_BTN}>
                  Médico
                </button>
                <button type="submit" name="reasonCategory" value="OTHER_JUSTIFIED" className={SECONDARY_BTN}>
                  Otro (justificado)
                </button>
                <button type="submit" name="reasonCategory" value="UNJUSTIFIED" className={DANGER_BTN}>
                  No justificado
                </button>
              </div>
            </form>
          )}
        </Section>
      )}

      {detail.absence && (
        <Section title={detail.absence.absenceTypeName}>
          <p className="text-xs text-slate-500">
            {detail.absence.startDate} — {detail.absence.endDate}
          </p>
          {detail.absence.decision ? (
            <AbsenceDecisionSummary detail={detail} date={date} area={area} />
          ) : (
            <form action={markAbsencePendingDocumentAction} className="space-y-2">
              <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
              <input type="hidden" name="absenceRecordId" value={detail.absence.recordId} />
              <input type="hidden" name="startDate" value={date} />
              <p className="text-sm text-slate-700">¿Trabajador con licencia?</p>
              <CommentField />
              <div className="flex gap-2">
                <button type="submit" className={PRIMARY_BTN}>
                  Sí
                </button>
                <button type="submit" formAction={disputeAbsenceAction} className={SECONDARY_BTN}>
                  No
                </button>
              </div>
            </form>
          )}
        </Section>
      )}

      {detail.documents.length > 0 && (
        <Section title="Documentos">
          <ul className="space-y-1 text-xs text-slate-600">
            {detail.documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between">
                <span>{doc.originalFilename}</span>
                <DecisionBadge label={`Adjuntado ${formatInstantInSantiago(doc.uploadedAt, { day: "2-digit", month: "short" })}`} tone="positive" />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </aside>
  );
}

function EarlyDepartureDecisionSummary({ detail, date, area }: { detail: DailyReviewDetailViewModel; date: string; area: AreaCode }) {
  const decision = detail.earlyDeparture!.decision!;
  if (decision.reasonCategory === "MEDICAL" && decision.payrollEffect === "NEEDS_REVIEW") {
    const isOverdue = Boolean(decision.documentDeadline && decision.documentDeadline < date);
    return (
      <div className="space-y-2">
        <DecisionBadge label={isOverdue ? "Vencido" : "Comprobante pendiente"} tone={isOverdue ? "negative" : "neutral"} />
        {decision.documentDeadline && <p className="text-xs text-slate-500">Plazo: {formatCalendarDate(decision.documentDeadline)}</p>}
        <p className="text-xs text-slate-500">Debes adjuntar el comprobante médico para cerrar este caso.</p>
        <form action={uploadDocumentAction} className="space-y-1.5">
          <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
          <input type="hidden" name="documentType" value="MEDICAL_CERTIFICATE" />
          <input type="hidden" name="relationKind" value="EARLY_DEPARTURE" />
          <input type="hidden" name="relationId" value={detail.earlyDeparture!.recordId} />
          <input type="file" name="file" required aria-label="Adjuntar comprobante médico" className={UPLOAD_INPUT} />
          <button type="submit" className={UPLOAD_BTN}>
            Adjuntar comprobante
          </button>
        </form>
        <form action={confirmEarlyDepartureMedicalDocumentAction}>
          <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
          <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture!.recordId} />
          <button type="submit" className={PRIMARY_BTN}>
            Confirmar documento recibido
          </button>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <DecisionBadge
        label={decision.reasonCategory === "OTHER_JUSTIFIED" ? "Justificado" : decision.reasonCategory === "UNJUSTIFIED" ? "No justificado" : decision.reasonCategory}
        tone={decision.payrollEffect === "DO_NOT_DEDUCT" ? "positive" : "negative"}
      />
      <p className="text-xs text-slate-500">{formatDecidedAt(decision.decidedAt)}</p>
    </div>
  );
}

function AbsenceDecisionSummary({ detail, date, area }: { detail: DailyReviewDetailViewModel; date: string; area: AreaCode }) {
  const decision = detail.absence!.decision!;
  if (decision.status === "PENDING_DOCUMENT") {
    const isOverdue = Boolean(decision.documentDeadline && decision.documentDeadline < date);
    return (
      <div className="space-y-2">
        <DecisionBadge label={isOverdue ? "Vencido" : "Documento pendiente"} tone={isOverdue ? "negative" : "neutral"} />
        {decision.documentDeadline && <p className="text-xs text-slate-500">Plazo: {formatCalendarDate(decision.documentDeadline)}</p>}
        <p className="text-xs text-slate-500">Debes adjuntar el documento de respaldo para cerrar este caso.</p>
        <form action={uploadDocumentAction} className="space-y-1.5">
          <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
          <input type="hidden" name="documentType" value="OTHER" />
          <input type="hidden" name="relationKind" value="ABSENCE" />
          <input type="hidden" name="relationId" value={detail.absence!.recordId} />
          <input type="file" name="file" required aria-label="Adjuntar licencia" className={UPLOAD_INPUT} />
          <button type="submit" className={UPLOAD_BTN}>
            Adjuntar licencia
          </button>
        </form>
        <form action={confirmAbsenceDocumentAction}>
          <HiddenContext employeeId={detail.employeeId} date={date} area={area} />
          <input type="hidden" name="absenceRecordId" value={detail.absence!.recordId} />
          <input type="hidden" name="startDate" value={date} />
          <button type="submit" className={PRIMARY_BTN}>
            Confirmar documento recibido
          </button>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <DecisionBadge label={decision.status === "CONFIRMED" ? "Confirmado" : decision.status === "DISPUTED" ? "En disputa" : decision.status} tone={decision.status === "CONFIRMED" ? "positive" : "neutral"} />
      <p className="text-xs text-slate-500">{formatDecidedAt(decision.decidedAt)}</p>
    </div>
  );
}
