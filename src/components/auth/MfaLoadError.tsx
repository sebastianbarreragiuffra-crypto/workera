import Link from "next/link";
import { MfaSignOut } from "./MfaSignOut";

export function MfaLoadError({ retryHref }: { retryHref: "/login/mfa" | "/seguridad/mfa" }) {
  return (
    <section
      role="alert"
      className="rounded-xl border border-critical-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-base font-semibold text-foreground">No pudimos comprobar tu segundo factor</h2>
      <p className="mt-2 text-sm text-slate-600">
        Por seguridad no continuaremos mientras el estado de autenticación sea incierto. Reintenta; si el problema
        continúa, cierra sesión y vuelve a ingresar.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Link
          href={retryHref}
          prefetch={false}
          className="rounded-md bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark"
        >
          Reintentar
        </Link>
        <MfaSignOut />
      </div>
    </section>
  );
}
