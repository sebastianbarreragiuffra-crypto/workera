import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDocumentCenter } from "../../../lib/view-models/documents-view";
import { getEmployeeRoster } from "../../../lib/view-models/employees-view";
import { areasVisibleToRole, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago, formatDateLong } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";
import { PageHeader } from "../../../components/shell/PageHeader";
import { SectionCard } from "../../../components/shell/SectionCard";
import { FilterBar, type FilterOption } from "../../../components/shell/FilterBar";
import { uploadGeneralDocumentAction, viewDocumentAction } from "./actions";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  MEDICAL_CERTIFICATE: "Comprobante médico",
  TRANSPORT_PROOF: "Comprobante de transporte",
  IDENTIFICATION: "Identificación",
  OTHER: "Otro",
};

export default async function DocumentCenterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const allowedAreas = areasVisibleToRole(profile.role);
  const params = await searchParams;
  const areaFilter = params.area as AreaCode | undefined;
  const done = params.hecho;

  const supabase = await createClient();

  let documents;
  let roster;
  try {
    [documents, roster] = await Promise.all([
      getDocumentCenter(supabase, profile.role, { areaCode: areaFilter }),
      getEmployeeRoster(supabase, profile.role, { areaCode: areaFilter, activeOnly: true }, todayInSantiago()),
    ]);
  } catch {
    return <ErrorState retryHref="/documentos" />;
  }

  const areaFilterOptions: FilterOption[] =
    allowedAreas.length > 1
      ? [
          { key: "all", label: "Todas", href: "/documentos", active: !areaFilter },
          ...allowedAreas.map((area) => ({ key: area, label: AREA_LABEL[area], href: `/documentos?area=${area}`, active: areaFilter === area })),
        ]
      : [];

  return (
    <div className="space-y-4">
      <PageHeader title="Documentos" subtitle={`${documents.length} documento${documents.length === 1 ? "" : "s"}`} />

      {done && (
        <div role="status" className="rounded-lg border border-success-border bg-success-bg p-3 text-sm text-success">
          ✓ Documento adjuntado
        </div>
      )}

      {areaFilterOptions.length > 0 && <FilterBar options={areaFilterOptions} />}

      <SectionCard title="Adjuntar documento">
        <form action={uploadGeneralDocumentAction} className="flex flex-wrap items-end gap-3">
          {areaFilter && <input type="hidden" name="area" value={areaFilter} />}
          <div>
            <label htmlFor="employeeId" className="text-xs font-medium text-slate-500">
              Trabajador
            </label>
            <select id="employeeId" name="employeeId" required className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              <option value="">Selecciona…</option>
              {roster.map((e) => (
                <option key={e.employeeId} value={e.employeeId}>
                  {e.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="documentType" className="text-xs font-medium text-slate-500">
              Tipo
            </label>
            <select id="documentType" name="documentType" required className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {Object.entries(DOCUMENT_TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="file" className="text-xs font-medium text-slate-500">
              Archivo
            </label>
            <input id="file" type="file" name="file" required className="mt-1 block text-sm" />
          </div>
          <button type="submit" className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark">
            Adjuntar
          </button>
        </form>
      </SectionCard>

      {documents.length === 0 ? (
        <EmptyState message="No hay documentos que coincidan." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Trabajador
                </th>
                <th scope="col" className="px-4 py-3">
                  Tipo
                </th>
                <th scope="col" className="px-4 py-3">
                  Archivo
                </th>
                <th scope="col" className="px-4 py-3">
                  Adjuntado
                </th>
                <th scope="col" className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link href={`/empleados/${doc.employeeId}`} className="hover:underline">
                      {doc.employeeDisplayName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType}</td>
                  <td className="px-4 py-3 text-slate-600">{doc.originalFilename}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDateLong(doc.uploadedAt.slice(0, 10))}</td>
                  <td className="px-4 py-3 text-right">
                    {doc.canView ? (
                      <form action={viewDocumentAction}>
                        <input type="hidden" name="documentId" value={doc.id} />
                        <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          Ver
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-slate-400">Solo RRHH</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
