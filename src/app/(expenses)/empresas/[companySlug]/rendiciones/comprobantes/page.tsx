import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ExpenseCaptureAttachForm,
  ExpenseCaptureDiscardForm,
  ExpenseCaptureUploadForms,
  ExpenseEmailConnectorCard,
  ExpenseWhatsappConnectorCard,
} from "@/components/expenses/ExpenseCaptureForms";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseReceiptInbox } from "@/lib/expenses/captures";
import { getExpenseEmailConnector } from "@/lib/expenses/email-capture";
import { getExpenseWhatsappConnector } from "@/lib/expenses/whatsapp-capture";
import { createClient } from "@/lib/supabase/server";

function captureDate(value: string): string {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(new Date(value));
}

function fileSize(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
}

export default async function ExpenseReceiptInboxPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context?.canSubmit) notFound();

  const [{ captures, draftItems }, emailConnector, whatsappConnector] = await Promise.all([
    getExpenseReceiptInbox(supabase, context),
    getExpenseEmailConnector(supabase, context),
    getExpenseWhatsappConnector(supabase, context),
  ]);
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Captura rápida</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Mis comprobantes</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">
            Fotografía o sube una boleta apenas la recibas. Quedará privada hasta que la asocies a una rendición.
          </p>
        </div>
        <div className="inline-flex min-h-11 items-center self-start rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm sm:self-auto">
          {captures.length} pendiente{captures.length === 1 ? "" : "s"}
        </div>
      </header>

      <ExpenseCaptureUploadForms companySlug={context.slug} />

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-slate-900">Pendientes de asociar</h2>
            <p className="mt-0.5 text-xs text-slate-500">{captures.length} de un máximo de 50 comprobantes pendientes.</p>
          </div>
          {draftItems.length === 0 && (
            <Link href={`${base}/nueva`} className="text-sm font-semibold text-arcotex-blue-dark hover:underline">Crear una rendición</Link>
          )}
        </div>

        {captures.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="text-3xl" aria-hidden="true">◇</div>
            <h3 className="mt-3 font-medium text-slate-900">Tu bandeja está al día</h3>
            <p className="mt-1 text-sm text-slate-500">Las nuevas fotos y archivos aparecerán aquí hasta que los asocies.</p>
          </div>
        ) : (
          <>
            {draftItems.length > 0 ? (
              <div className="border-b border-slate-100 bg-slate-50 p-5">
                <ExpenseCaptureAttachForm
                  companySlug={context.slug}
                  captures={captures.map((capture) => ({ id: capture.id, label: capture.originalFilename }))}
                  draftItems={draftItems}
                />
              </div>
            ) : (
              <p className="border-b border-slate-100 bg-slate-50 px-5 py-4 text-sm text-slate-500">Crea una rendición y agrega al menos un gasto para asociar estos comprobantes.</p>
            )}
            <ul className="divide-y divide-slate-100">
            {captures.map((capture) => (
              <li key={capture.id} className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`${base}/comprobantes/capturas/${capture.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-medium text-slate-900 hover:text-arcotex-blue-dark hover:underline"
                    >
                      {capture.originalFilename}
                    </Link>
                    {capture.possibleDuplicate && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Posible duplicado</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {capture.source === "WEB_CAMERA" ? "Foto" : capture.source === "EMAIL" ? "Correo" : capture.source === "WHATSAPP" ? "WhatsApp" : "Archivo"} · {fileSize(capture.fileSize)} · {captureDate(capture.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                  <Link
                    href={`${base}/comprobantes/capturas/${capture.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Ver comprobante
                  </Link>
                  <ExpenseCaptureDiscardForm companySlug={context.slug} captureId={capture.id} />
                </div>
              </li>
            ))}
            </ul>
          </>
        )}
      </section>

      <ExpenseEmailConnectorCard companySlug={context.slug} {...emailConnector} />
      <ExpenseWhatsappConnectorCard companySlug={context.slug} {...whatsappConnector} />
    </div>
  );
}
