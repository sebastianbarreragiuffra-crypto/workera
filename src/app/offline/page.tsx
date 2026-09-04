import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-arcotex-navy text-xl font-bold text-white" aria-hidden="true">G</div>
        <h1 className="mt-5 text-2xl font-bold text-slate-950">Sin conexión</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          GESTORA no guarda rendiciones, comprobantes ni datos personales en este dispositivo. Recupera la conexión para continuar de forma segura.
        </p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-arcotex-blue px-5 py-3 text-sm font-semibold text-white hover:bg-arcotex-blue-dark">
          Reintentar conexión
        </Link>
      </section>
    </main>
  );
}
