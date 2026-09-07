/**
 * Señal pública y deliberadamente mínima para monitores de disponibilidad.
 * No consulta Supabase ni integraciones: confirma que DNS, CDN y el runtime de
 * Next.js pueden atender una invocación. La salud operacional profunda se
 * mantiene privada porque contiene información interna de jobs y proveedores.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { status: "ok" },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
