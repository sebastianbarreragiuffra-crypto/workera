"use client";

import { Suspense, useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArcotexLogo } from "../../components/shell/ArcotexLogo";
import { login, loginWithGoogle, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

const VALUE_POINTS: { title: string; icon: "shield" | "activity" | "layers" }[] = [
  { title: "Seguridad de datos", icon: "shield" },
  { title: "Información en tiempo real", icon: "activity" },
  { title: "Gestión por áreas y roles", icon: "layers" },
];

function ValueIcon({ name }: { name: "shield" | "activity" | "layers" }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l2 7 4-14 2 7h6" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="M12 3l9 5-9 5-9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      );
  }
}

function EyeIcon({ open }: { open: boolean }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return open ? (
    <svg {...common}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A11 11 0 0 1 12 5c7 0 11 7 11 7a17.9 17.9 0 0 1-3.4 4.3M6.6 6.6C3.7 8.4 1 12 1 12s4 7 11 7a10.6 10.6 0 0 0 4.4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.89c2.27-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.89-3c-1.08.73-2.46 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.95H1.26v3.11A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.26a12 12 0 0 0 0 10.8z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.35.61 4.6 1.8l3.45-3.45C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.6l4.01 3.11C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

/** Lee `?error=oauth` para mostrar el mismo tipo de mensaje genérico que el login por contraseña -- nunca detalle interno del proveedor. */
function OAuthErrorBanner() {
  const searchParams = useSearchParams();
  if (searchParams.get("error") !== "oauth") return null;
  return (
    <p role="alert" className="mt-4 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
      No pudimos completar el inicio de sesión con Google.
    </p>
  );
}

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#f4f8fb]">
      <div className="hidden w-[42%] shrink-0 flex-col justify-between bg-gradient-to-br from-[#071018] via-[#0b2a3f] to-[#1f6f9f] px-10 py-12 text-white lg:flex xl:px-14">
        <ArcotexLogo inverse className="h-20 w-48" />

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">Plataforma de Gestión Workera</h1>
          <p className="mt-4 text-sm leading-relaxed text-blue-50/80">
            Controla, revisa y gestiona la asistencia de tu equipo de forma simple, confiable y eficiente.
          </p>

          <ul className="mt-8 space-y-4">
            {VALUE_POINTS.map((point) => (
              <li key={point.title} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-[#8ed2f5]">
                  <ValueIcon name={point.icon} />
                </span>
                <span className="text-sm font-medium text-blue-50/90">{point.title}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-blue-100/50">© 2026 ARCOTEX. Todos los derechos reservados.</p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex justify-center lg:hidden">
            <ArcotexLogo className="h-20 w-48" />
          </div>

          <div className="rounded-xl border border-[#d5e3ec] bg-white p-8 shadow-[0_18px_50px_-28px_rgba(11,42,63,0.35)]">
            <div className="mb-6 hidden justify-center lg:flex">
              <ArcotexLogo className="h-16 w-40" />
            </div>

            <h2 className="text-center text-xl font-semibold text-[#111827]">Bienvenido de nuevo</h2>
            <p className="mt-1 text-center text-sm text-[#607486]">Inicia sesión para continuar</p>

            <Suspense fallback={null}>
              <OAuthErrorBanner />
            </Suspense>

            <form action={formAction} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="text-xs font-medium text-[#263b4b]">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  name="email"
                  required
                  autoComplete="username"
                  className="mt-1 block w-full rounded-md border border-[#bfd0dc] bg-[#fbfdff] px-3 py-2 text-sm text-[#111827] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f82bb]"
                />
              </div>

              <div>
                <label htmlFor="password" className="text-xs font-medium text-[#263b4b]">
                  Contraseña
                </label>
                <div className="relative mt-1">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    name="password"
                    required
                    autoComplete="current-password"
                    className="block w-full rounded-md border border-[#bfd0dc] bg-[#fbfdff] px-3 py-2 pr-10 text-sm text-[#111827] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f82bb]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-[#718596] hover:text-[#2f82bb] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f82bb]"
                  >
                    <EyeIcon open={showPassword} />
                  </button>
                </div>
              </div>

              {state.error ? (
                <p role="alert" className="rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
                  {state.error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-md bg-[#2f82bb] px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#236b9d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f82bb] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Ingresando..." : "Iniciar sesión"}
              </button>
            </form>

            <div className="mt-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-[#dbe5ec]" />
              <span className="text-xs text-[#718596]">o continúa con</span>
              <span className="h-px flex-1 bg-[#dbe5ec]" />
            </div>

            <form action={loginWithGoogle} className="mt-4">
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-md border border-[#bfd0dc] px-4 py-2.5 text-sm font-medium text-[#263b4b] hover:bg-[#eef6fb] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f82bb]"
              >
                <GoogleIcon />
                Continuar con Google
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-[#718596]">Acceso exclusivo para colaboradores</p>
          </div>

          <p className="mt-6 text-center text-xs text-[#718596] lg:hidden">© 2026 ARCOTEX. Todos los derechos reservados.</p>
        </div>
      </div>
    </div>
  );
}
