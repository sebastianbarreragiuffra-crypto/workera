import Link from "next/link";

export default function CompanyNotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">Empresa no encontrada</h1>
      <p className="mt-2 text-sm text-slate-500">No existe en la cartera o tu cuenta no tiene acceso al control plane.</p>
      <Link href="/plataforma/empresas" className="mt-5 inline-flex rounded-md bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark">
        Volver a empresas
      </Link>
    </div>
  );
}
