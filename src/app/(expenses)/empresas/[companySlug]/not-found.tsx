import Link from "next/link";
import { GestoraBrand } from "@/components/platform/GestoraBrand";

/**
 * Frontera de 404 del LAYOUT de Rendiciones: `rendiciones/layout.tsx` llama
 * a `notFound()` cuando el slug de la URL no corresponde a una empresa
 * donde esta persona tenga membresía activa y el módulo habilitado. Ese
 * caso es rutinario (alguien pega una URL ajena o vieja), no excepcional.
 *
 * Vive un segmento MÁS ARRIBA que `rendiciones/` a propósito: una frontera
 * declarada dentro de `rendiciones/` no puede capturar lo que lanza el
 * layout de ese mismo segmento. Por eso tampoco puede envolverse en
 * ExpenseShell -- el contexto de empresa que el shell necesita es
 * justamente el que no se pudo resolver.
 */
export default function ExpenseCompanyNotFound() {
  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4">
        <GestoraBrand inverse />
      </header>
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-950">Rendiciones no está disponible para esta empresa</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          La empresa no existe, tu membresía no está activa ahí, o el módulo de Rendiciones no está contratado.
        </p>
        <Link
          href="/rendiciones"
          className="mt-6 inline-flex rounded-lg bg-arcotex-blue px-4 py-2.5 text-sm font-semibold text-white hover:bg-arcotex-blue-dark"
        >
          Ver mis empresas
        </Link>
      </main>
    </div>
  );
}
