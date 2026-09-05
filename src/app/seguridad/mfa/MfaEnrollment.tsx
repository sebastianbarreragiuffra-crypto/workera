"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  confirmMfaEnrollmentAction,
  discardMfaFactorAction,
  startMfaEnrollmentAction,
  type MfaEnrollment as MfaEnrollmentData,
  type MfaEnrollmentState,
} from "./actions";

const MFA_ENROLLMENT_INITIAL_STATE: MfaEnrollmentState = {
  status: "idle",
  message: "",
  enrollment: null,
};

export interface MfaFactorView {
  id: string;
  friendlyName: string;
  createdAt: string;
}

interface MfaEnrollmentProps {
  verifiedFactors: MfaFactorView[];
  unverifiedFactors: MfaFactorView[];
  /** Si la cuenta está en el conjunto que exige segundo factor. */
  requiresMfa: boolean;
  /** El OWNER recibe una recomendación explícita de respaldo. */
  isPlatformOwner: boolean;
}

const INPUT_CLASS =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100";

function SubmitButton({ children, variant = "primary" }: { children: React.ReactNode; variant?: "primary" | "quiet" }) {
  const { pending } = useFormStatus();
  const base =
    "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue";
  const skin =
    variant === "primary"
      ? "bg-arcotex-blue text-white hover:bg-arcotex-blue-dark"
      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button type="submit" disabled={pending} className={`${base} ${skin}`}>
      {pending ? "Procesando…" : children}
    </button>
  );
}

function Feedback({ state }: { state: MfaEnrollmentState }) {
  if (state.status === "idle" || state.status === "enrolling" || state.message === "") return null;
  const isError = state.status === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mt-3 rounded-md px-3 py-2 text-sm ${isError ? "bg-critical-bg text-critical" : "bg-success-bg text-success"}`}
    >
      {state.message}
    </p>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function MfaEnrollment({
  verifiedFactors,
  unverifiedFactors,
  requiresMfa,
  isPlatformOwner,
}: MfaEnrollmentProps) {
  const [enrollment, setEnrollment] = useState<MfaEnrollmentData | null>(null);
  const [feedback, setFeedback] = useState<MfaEnrollmentState>(MFA_ENROLLMENT_INITIAL_STATE);

  async function startEnrollment(formData: FormData) {
    const result = await startMfaEnrollmentAction(formData);
    setFeedback(result);
    setEnrollment(result.enrollment);
  }

  async function confirmEnrollment(formData: FormData) {
    const result = await confirmMfaEnrollmentAction(formData);
    setFeedback(result);
    if (result.status === "done") setEnrollment(null);
  }

  async function discardFactor(formData: FormData) {
    const result = await discardMfaFactorAction(formData);
    setFeedback(result);
  }

  const hasSecondFactor = verifiedFactors.length > 0;
  const ownerNeedsBackupFactor = isPlatformOwner && verifiedFactors.length < 2;
  const suggestedName =
    verifiedFactors.length === 0 ? "Teléfono principal" : isPlatformOwner ? "Respaldo impreso" : "Segundo dispositivo";

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-card p-6 shadow-sm">
        <h2 className="text-base font-semibold text-foreground">Estado de tu segundo factor</h2>

        {hasSecondFactor ? (
          <ul className="mt-4 space-y-2">
            {verifiedFactors.map((factor) => (
              <li
                key={factor.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2"
              >
                <span className="text-sm text-slate-800">
                  <span className="font-medium">{factor.friendlyName}</span>
                  <span className="ml-2 text-xs text-slate-500">verificado el {formatDate(factor.createdAt)}</span>
                </span>
                <form action={discardFactor}>
                  <input type="hidden" name="factorId" value={factor.id} />
                  <SubmitButton variant="quiet">Dar de baja</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-600">
            {requiresMfa
              ? "Tu cuenta tiene permisos que exigen un segundo factor. Todavía no inscribiste ninguno."
              : "Tu cuenta todavía no tiene un segundo factor inscrito."}
          </p>
        )}

        {ownerNeedsBackupFactor ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-medium">
              {hasSecondFactor ? "Recomendación: agrega un autenticador de respaldo." : "Recomendación para recuperación."}
            </p>
            <p className="mt-1">
              Supabase no entrega códigos de recuperación de un solo uso. Te recomendamos inscribir un segundo factor
              TOTP y guardar su secreto en un lugar físico seguro. Si no lo haces, la recuperación seguirá dependiendo
              del procedimiento break-glass del panel de Supabase.
            </p>
          </div>
        ) : null}

        {unverifiedFactors.length > 0 ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm text-slate-700">
              Tienes una inscripción a medio terminar. Un factor sin confirmar no protege nada: descártalo y empieza de
              nuevo.
            </p>
            <ul className="mt-2 space-y-2">
              {unverifiedFactors.map((factor) => (
                <li key={factor.id} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-slate-600">{factor.friendlyName}</span>
                  <form action={discardFactor}>
                    <input type="hidden" name="factorId" value={factor.id} />
                    <SubmitButton variant="quiet">Descartar</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Feedback state={feedback} />
      </section>

      {enrollment ? (
        <section className="rounded-xl border border-slate-200 bg-card p-6 shadow-sm">
          <h2 className="text-base font-semibold text-foreground">Escanea el código</h2>
          <p className="mt-1 text-sm text-slate-600">
            Sirve cualquier aplicación de autenticación: Google Authenticator, Microsoft Authenticator, Authy, 1Password.
            Elige la que prefieras.
          </p>

          <div className="mt-4 flex flex-wrap items-start gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element -- el QR es un SVG en data URI que devuelve Supabase Auth; next/image no aporta nada sobre un recurso ya embebido y exigiría `unoptimized`. */}
            <img
              src={enrollment.qrCodeDataUri}
              alt="Código QR para inscribir tu aplicación de autenticación"
              width={200}
              height={200}
              className="rounded-md border border-slate-200 bg-white p-2"
            />

            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-slate-700">¿No puedes escanear? Escribe este secreto:</p>
              <code className="mt-1 block break-all rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800">
                {enrollment.secret}
              </code>

              <form action={confirmEnrollment} className="mt-4">
                <input type="hidden" name="factorId" value={enrollment.factorId} />
                <label htmlFor="mfa-code" className="text-xs font-medium text-slate-700">
                  Código de 6 dígitos
                </label>
                <input
                  id="mfa-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  className={INPUT_CLASS}
                  placeholder="123456"
                />
                <div className="mt-3">
                  <SubmitButton>Confirmar dispositivo</SubmitButton>
                </div>
              </form>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-card p-6 shadow-sm">
          <h2 className="text-base font-semibold text-foreground">
            {hasSecondFactor ? "Inscribir otro autenticador" : "Inscribir tu autenticador"}
          </h2>
          <form action={startEnrollment} className="mt-4 max-w-sm">
            <label htmlFor="friendlyName" className="text-xs font-medium text-slate-700">
              Nombre para reconocerlo
            </label>
            <input
              id="friendlyName"
              name="friendlyName"
              required
              minLength={2}
              maxLength={40}
              defaultValue={suggestedName}
              className={INPUT_CLASS}
            />
            <div className="mt-3">
              <SubmitButton>Generar código QR</SubmitButton>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
