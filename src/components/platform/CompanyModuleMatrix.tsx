import { Badge } from "../shell/Badge";
import { SectionCard } from "../shell/SectionCard";
import { EmptyState } from "../shell/StateMessages";
import { presentModuleStatus } from "./status-presenters";
import type { CompanyModuleItem } from "./types";

function AccessLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-sm text-slate-400">Sin accesos asignados</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{label}</span>)}
    </div>
  );
}

function ModuleMobileCard({ module }: { module: CompanyModuleItem }) {
  const status = presentModuleStatus(module.status);
  return (
    <article className="rounded-lg border border-border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{module.category}</div>
          <h3 className="mt-1 font-medium text-slate-900">{module.name}</h3>
        </div>
        <Badge label={status.label} tone={status.tone} />
      </div>
      <p className="mt-2 text-sm leading-5 text-slate-500">{module.description}</p>
      <div className="mt-3 border-t border-slate-100 pt-3">
        <div className="mb-1.5 text-xs font-medium text-slate-500">Acceso asignado</div>
        <AccessLabels labels={module.accessLabels} />
      </div>
      {module.configurationSummary && <p className="mt-3 text-xs text-slate-500">{module.configurationSummary}</p>}
    </article>
  );
}

export function CompanyModuleMatrix({
  modules,
  title = "Módulos de la empresa",
  emptyMessage = "No hay módulos configurados para esta empresa.",
  actionsByModule,
}: {
  modules: CompanyModuleItem[];
  title?: string;
  emptyMessage?: string;
  actionsByModule?: Record<string, React.ReactNode>;
}) {
  return (
    <SectionCard title={title} actions={!actionsByModule ? <span className="text-xs font-medium text-slate-400">Solo lectura</span> : undefined}>
      {modules.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <>
          <div className="grid gap-3 md:hidden">
            {modules.map((module) => (
              <div key={module.key}>
                <ModuleMobileCard module={module} />
                {actionsByModule?.[module.key]}
              </div>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="pb-3 pr-4">Módulo</th>
                  <th scope="col" className="px-4 pb-3">Estado</th>
                  <th scope="col" className="px-4 pb-3">Acceso asignado</th>
                  <th scope="col" className="pl-4 pb-3">Configuración</th>
                  {actionsByModule && <th scope="col" className="pl-4 pb-3">Administrar</th>}
                </tr>
              </thead>
              <tbody>
                {modules.map((module) => {
                  const status = presentModuleStatus(module.status);
                  return (
                    <tr key={module.key} className="border-b border-slate-100 last:border-0">
                      <td className="py-3 pr-4 align-top">
                        <div className="font-medium text-slate-900">{module.name}</div>
                        <div className="mt-0.5 text-xs text-slate-400">{module.category}</div>
                        <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{module.description}</p>
                      </td>
                      <td className="px-4 py-3 align-top"><Badge label={status.label} tone={status.tone} /></td>
                      <td className="px-4 py-3 align-top"><AccessLabels labels={module.accessLabels} /></td>
                      <td className="pl-4 py-3 align-top text-xs leading-5 text-slate-500">{module.configurationSummary ?? "Sin configuración adicional"}</td>
                      {actionsByModule && <td className="pl-4 py-3 align-top">{actionsByModule[module.key]}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}
