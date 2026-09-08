import { NextResponse, type NextRequest } from "next/server";
import {
  ARCOTEX_SHADOW_KEY_ENV,
  ARCOTEX_SHADOW_KEY_HEADER,
} from "./arcotex-shadow-constants";

/**
 * Sustituto compilado únicamente por el servidor Playwright local. La clave
 * efímera no viaja en el repositorio y una petición sin ella falla cerrada.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const expectedKey = process.env[ARCOTEX_SHADOW_KEY_ENV];
  const receivedKey = request.headers.get(ARCOTEX_SHADOW_KEY_HEADER);

  if (!expectedKey || receivedKey !== expectedKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.next({ request });
}
