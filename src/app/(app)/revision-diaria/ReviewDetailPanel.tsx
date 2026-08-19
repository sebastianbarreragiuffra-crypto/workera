import type { DailyReviewDetailViewModel } from "../../../lib/view-models/daily-review-view";
import type { AreaCode } from "../../../lib/access/scope";
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
  return new Date(value).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
}

function HiddenContext({ employeeId, date }: { employeeId: string; date: string }) {
  return (
    <>
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="date" value={date} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-4 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

const PRIMARY_BTN = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700";
const SECONDARY_BTN = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";
const DANGER_BTN = "rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50";

export function ReviewDetailPanel({
  detail,
  date,
}: {
  detail: DailyReviewDetailViewModel;
  date: string;
  area: AreaCode;
}) {
  return (
    <aside
      aria-label={`Detalle de ${detail.displayName}`}
      className="sticky top-0 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h2 className="text-base font-semibold text-slate-900">{detail.displayName}</h2>
        {detail.isBirthdayToday && (
          <p className="mt-1 text-sm font-medium text-pink-600">🎂 Cumpleaños hoy</p>
        )}
      </div>

      <Section title="Control horario">
        {detail.timeControl.kind === "EXEMPT" ? (
          <p className="text-sm font-medium text-slate-700">
            EXENTO
            <span className="ml-2 text-xs text-slate-500">
              ({detail.timeControl.legalBasis === "NO_MARKING_REQUIRED" ? "sin marcación" : detail.timeControl.legalBasis === "ARTICLE_22" ? "Artículo 22" : "otro"})
            </span>
          </p>
        ) : (
          <p className="text-sm text-slate-700">Normal</p>
        )}
      </Section>

      <Section title="Horario esperado">
        {detail.schedule.kind === "SCHEDULED" && (
          <p className="text-sm text-slate-700">
            {detail.schedule.scheduledStart.slice(0, 5)} → {detail.schedule.scheduledEnd.slice(0, 5)}
          </p>
        )}
        {detail.schedule.kind === "DAY_OFF" && <p className="text-sm text-slate-500">Día libre</p>}
        {detail.schedule.kind === "NO_SCHEDULE_ASSIGNED" && <p className="text-sm text-amber-700">Sin horario asignado</p>}
        {detail.schedule.kind === "EXEMPT" && <p className="text-sm text-slate-500">No aplica (exento)</p>}
      </Section>

      <Section title="Marcaciones">
        <p className="text-sm text-slate-700">Entrada {formatTime(detail.clockIn)}</p>
        <p className="text-sm text-slate-700">Salida {formatTime(detail.clockOut)}</p>
        {detail.missingPunch && <p className="text-xs font-medium text-red-600">⚠ Marcación faltante</p>}
      </Section>

      {detail.lateArrival && (
        <Section title="Atraso">
          <p className="text-sm text-slate-700">{detail.lateArrival.detectedMinutes} minutos</p>
          {detail.lateArrival.decision ? (
            <p className="text-xs text-slate-500">
              {detail.lateArrival.decision.justified ? "Justificado" : "No justificado"} — {detail.lateArrival.decision.payrollMinutes} min a liquidación
            </p>
          ) : (
            <div className="flex gap-2 pt-1">
              <form action={decideLateArrivalAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="lateArrivalRecordId" value={detail.lateArrival.recordId} />
                <input type="hidden" name="justified" value="true" />
                <button type="submit" className={PRIMARY_BTN}>
                  Justificar
                </button>
              </form>
              <form action={decideLateArrivalAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="lateArrivalRecordId" value={detail.lateArrival.recordId} />
                <input type="hidden" name="justified" value="false" />
                <button type="submit" className={SECONDARY_BTN}>
                  No justificar
                </button>
              </form>
            </div>
          )}
        </Section>
      )}

      {detail.overtime && (
        <Section title="Horas extra">
          <p className="text-sm text-slate-700">{detail.overtime.candidateMinutes} minutos detectados</p>
          {detail.overtime.bonusAmount !== null && (
            <p className="text-xs text-slate-500">Bono diario: ${detail.overtime.bonusAmount.toLocaleString("es-CL")}</p>
          )}
          {detail.overtime.decision ? (
            <p className="text-xs text-slate-500">
              {detail.overtime.decision.status} — {detail.overtime.decision.approvedMinutes} min aprobados
            </p>
          ) : (
            <div className="flex gap-2 pt-1">
              <form action={decideOvertimeAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="overtimeRecordId" value={detail.overtime.recordId} />
                <input type="hidden" name="action" value="APPROVE" />
                <button type="submit" className={PRIMARY_BTN}>
                  Aprobar
                </button>
              </form>
              <form action={decideOvertimeAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="overtimeRecordId" value={detail.overtime.recordId} />
                <input type="hidden" name="action" value="REJECT" />
                <button type="submit" className={DANGER_BTN}>
                  Rechazar
                </button>
              </form>
            </div>
          )}
        </Section>
      )}

      {detail.earlyDeparture && (
        <Section title="Salida anticipada">
          <p className="text-sm text-slate-700">{detail.earlyDeparture.detectedMinutes} minutos</p>
          {detail.earlyDeparture.decision ? (
            <EarlyDepartureDecisionSummary detail={detail} date={date} />
          ) : (
            <div className="flex flex-wrap gap-2 pt-1">
              <form action={markEarlyDepartureMedicalAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture.recordId} />
                <button type="submit" className={SECONDARY_BTN}>
                  Médico
                </button>
              </form>
              <form action={decideEarlyDepartureOtherAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture.recordId} />
                <input type="hidden" name="reasonCategory" value="OTHER_JUSTIFIED" />
                <button type="submit" className={SECONDARY_BTN}>
                  Otro (justificado)
                </button>
              </form>
              <form action={decideEarlyDepartureOtherAction}>
                <HiddenContext employeeId={detail.employeeId} date={date} />
                <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture.recordId} />
                <input type="hidden" name="reasonCategory" value="UNJUSTIFIED" />
                <button type="submit" className={DANGER_BTN}>
                  No justificado
                </button>
              </form>
            </div>
          )}
        </Section>
      )}

      {detail.absence && (
        <Section title="Ausencia / Licencia">
          {detail.absence.decision ? (
            <AbsenceDecisionSummary detail={detail} date={date} />
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-700">¿Trabajador con licencia?</p>
              <div className="flex gap-2">
                <form action={markAbsencePendingDocumentAction}>
                  <HiddenContext employeeId={detail.employeeId} date={date} />
                  <input type="hidden" name="absenceRecordId" value={detail.absence.recordId} />
                  <input type="hidden" name="startDate" value={date} />
                  <button type="submit" className={PRIMARY_BTN}>
                    Sí
                  </button>
                </form>
                <form action={disputeAbsenceAction}>
                  <HiddenContext employeeId={detail.employeeId} date={date} />
                  <input type="hidden" name="absenceRecordId" value={detail.absence.recordId} />
                  <button type="submit" className={SECONDARY_BTN}>
                    No
                  </button>
                </form>
              </div>
            </div>
          )}
        </Section>
      )}

      {detail.documents.length > 0 && (
        <Section title="Documentos">
          <ul className="space-y-1 text-xs text-slate-600">
            {detail.documents.map((doc) => (
              <li key={doc.id}>
                {doc.originalFilename} — {new Date(doc.uploadedAt).toLocaleDateString("es-CL")}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </aside>
  );
}

function EarlyDepartureDecisionSummary({ detail, date }: { detail: DailyReviewDetailViewModel; date: string }) {
  const decision = detail.earlyDeparture!.decision!;
  if (decision.reasonCategory === "MEDICAL" && decision.payrollEffect === "NEEDS_REVIEW") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-amber-700">Comprobante médico pendiente.</p>
        {decision.documentDeadline && <p className="text-xs text-slate-500">Plazo: {new Date(decision.documentDeadline).toLocaleDateString("es-CL")}</p>}
        <form action={uploadDocumentAction} encType="multipart/form-data" className="space-y-1.5">
          <HiddenContext employeeId={detail.employeeId} date={date} />
          <input type="hidden" name="documentType" value="MEDICAL_CERTIFICATE" />
          <input type="hidden" name="relationKind" value="EARLY_DEPARTURE" />
          <input type="hidden" name="relationId" value={detail.earlyDeparture!.recordId} />
          <input type="file" name="file" required aria-label="Adjuntar comprobante médico" className="text-xs" />
          <button type="submit" className={SECONDARY_BTN}>
            Adjuntar comprobante
          </button>
        </form>
        <form action={confirmEarlyDepartureMedicalDocumentAction}>
          <HiddenContext employeeId={detail.employeeId} date={date} />
          <input type="hidden" name="earlyDepartureRecordId" value={detail.earlyDeparture!.recordId} />
          <button type="submit" className={PRIMARY_BTN}>
            Confirmar documento recibido
          </button>
        </form>
      </div>
    );
  }
  return (
    <p className="text-xs text-slate-500">
      {decision.reasonCategory} — {decision.payrollEffect}
    </p>
  );
}

function AbsenceDecisionSummary({ detail, date }: { detail: DailyReviewDetailViewModel; date: string }) {
  const decision = detail.absence!.decision!;
  if (decision.status === "PENDING_DOCUMENT") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-amber-700">DOCUMENTO DE RESPALDO OBLIGATORIO</p>
        {decision.documentDeadline && <p className="text-xs text-slate-500">Plazo: {new Date(decision.documentDeadline).toLocaleDateString("es-CL")}</p>}
        <form action={uploadDocumentAction} encType="multipart/form-data" className="space-y-1.5">
          <HiddenContext employeeId={detail.employeeId} date={date} />
          <input type="hidden" name="documentType" value="OTHER" />
          <input type="hidden" name="relationKind" value="ABSENCE" />
          <input type="hidden" name="relationId" value={detail.absence!.recordId} />
          <input type="file" name="file" required aria-label="Adjuntar licencia" className="text-xs" />
          <button type="submit" className={SECONDARY_BTN}>
            Adjuntar licencia
          </button>
        </form>
        <form action={confirmAbsenceDocumentAction}>
          <HiddenContext employeeId={detail.employeeId} date={date} />
          <input type="hidden" name="absenceRecordId" value={detail.absence!.recordId} />
          <input type="hidden" name="startDate" value={date} />
          <button type="submit" className={PRIMARY_BTN}>
            Confirmar documento recibido
          </button>
        </form>
      </div>
    );
  }
  return <p className="text-xs text-slate-500">Estado: {decision.status}</p>;
}
