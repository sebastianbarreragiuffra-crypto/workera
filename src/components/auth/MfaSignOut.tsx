import { logout } from "@/app/login/actions";

/**
 * Salida de las dos pantallas de segundo factor.
 *
 * Existe porque cerrar sesión no es una ruta: es la Server Action `logout`, y
 * una Server Action se postea a la ruta que la renderiza. Con el bloqueo
 * activo, el gate del middleware saca a una sesión privilegiada en aal1 de
 * toda página que muestre el botón del shell, así que sin este control esa
 * persona no tiene ninguna forma de cerrar sesión desde la aplicación.
 *
 * Acá sí funciona: `/seguridad/mfa` y `/login/mfa` están en
 * `MFA_ALLOWED_PATHS`, y `logout` termina redirigiendo a `/login`, que también
 * lo está.
 */
export function MfaSignOut() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="text-sm font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
      >
        Cerrar sesión
      </button>
    </form>
  );
}
