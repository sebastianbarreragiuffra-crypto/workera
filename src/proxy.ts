import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Aplica a todas las rutas salvo assets estáticos, para no interferir
     * con imágenes/estilos/etc. La carga bancaria se excluye porque el proxy
     * puede clonar/materializar el body antes del corte streaming; esa ruta
     * autentica sesión, empresa, rol y origen por sí misma antes de leer bytes.
     */
    "/((?!api/expenses/[^/]+/bank-import$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
