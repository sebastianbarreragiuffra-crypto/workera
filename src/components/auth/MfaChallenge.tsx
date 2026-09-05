"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  verifyMfaChallengeAction,
  type MfaChallengeState,
} from "@/app/login/mfa/actions";

const MFA_CHALLENGE_INITIAL_STATE: MfaChallengeState = { status: "idle", message: "" };

export interface MfaChallengeFactor {
  id: string;
  friendlyName: string;
}

const INPUT_CLASS =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
    >
      {pending ? "Verificando…" : "Verificar"}
    </button>
  );
}

/**
 * Pide el código de 6 dígitos. Cuando la cuenta tiene más de un factor
 * verificado -- el caso del OWNER, que inscribe uno en el teléfono y otro
 * guardado fuera de él -- deja elegir cuál usar, porque justamente el segundo
 * existe para cuando el primero no está a mano.
 */
export function MfaChallenge({ factors }: { factors: MfaChallengeFactor[] }) {
  const [state, formAction] = useActionState(verifyMfaChallengeAction, MFA_CHALLENGE_INITIAL_STATE);

  return (
    <form action={formAction}>
      {factors.length > 1 ? (
        <div className="mb-4">
          <label htmlFor="factorId" className="text-xs font-medium text-slate-700">
            Autenticador
          </label>
          <select id="factorId" name="factorId" className={INPUT_CLASS} defaultValue={factors[0].id}>
            {factors.map((factor) => (
              <option key={factor.id} value={factor.id}>
                {factor.friendlyName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="factorId" value={factors[0].id} />
      )}

      <label htmlFor="code" className="text-xs font-medium text-slate-700">
        Código de 6 dígitos
      </label>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        autoFocus
        className={INPUT_CLASS}
        placeholder="123456"
      />

      {state.status === "error" ? (
        <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
          {state.message}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
