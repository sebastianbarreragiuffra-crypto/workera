# Google OAuth — preparación de código

Código preparado y proveedor local habilitado mediante variables de entorno.
La configuración de producción sigue siendo manual y externa: requiere acceso
a Google Cloud y al Dashboard de Supabase; las credenciales nunca se guardan
en este repositorio.

## Qué ya existe en el código

- `src/app/login/actions.ts` — `loginWithGoogle()`: arma la URL de
  autorización de Supabase (`signInWithOAuth`) y redirige.
- `src/app/auth/callback/route.ts` — recibe el `code` de vuelta de Google,
  llama `exchangeCodeForSession`, y redirige a `/` (mismo destino que el
  login por contraseña).
- `src/lib/supabase/middleware.ts` — `/auth/callback` agregado a
  `PUBLIC_PATHS` (necesario: llega antes de que exista sesión).
- `src/app/login/page.tsx` — botón "Continuar con Google".
- `supabase/config.toml` — `[auth.external.google]`, habilitado y configurado
  para leer Client ID/Secret desde variables de entorno, nunca hardcodeados.

## Por qué no hace falta código adicional para autorización

Un login de Google exitoso **solo crea una sesión** de Supabase Auth — igual
que email+password. El trigger `handle_new_auth_user` (Fase 3,
`supabase/migrations/20260817152004_auth_roles_and_helpers.sql`) crea el
`profile` con `role = NULL` para **cualquier** usuario nuevo, sin importar el
método de login. El layout de `(app)` (`src/app/(app)/layout.tsx`) exige
`profile.role` y `profile.active` para dejar pasar a cualquier pantalla — un
usuario de Google sin rol asignado rebota a `/login`, igual que un usuario de
password sin rol. Ninguna de las dos barreras es específica de un método de
login.

## Identity linking (evita duplicar el profile de un empleado)

Supabase Auth vincula automáticamente identidades OAuth a un usuario
existente cuando el email coincide y ya está verificado ("Automatic
Linking" — comportamiento nativo de GoTrue, no código de esta app;
confirmado en la documentación oficial de Supabase, agosto 2026). Si un
empleado ya tiene una cuenta de email+password con su email corporativo
verificado, iniciar sesión luego con Google usando el mismo email se vincula
a esa MISMA fila de `auth.users`/`profiles` — no crea un segundo profile.

## Separación de configuración local

- `supabase/config.toml` se versiona y es igual en todos los computadores. Sus
  puertos `5442x`, el `site_url` y la allowlist de callbacks pertenecen al
  proyecto Workera, no a una máquina particular.
- `.env` en la raíz no se versiona. Supabase CLI lo carga automáticamente para
  resolver los valores `env(...)` de `config.toml`; aquí van las credenciales
  locales de Google.
- `.env.local` tampoco se versiona. Lo usa Next.js para la URL y las claves de
  la instancia local de Supabase.
- `.env.staging` es independiente y apunta al proyecto remoto compartido.

Esta separación evita mezclar cambios de puertos con secretos o callbacks de
OAuth. Los dos PCs pueden reutilizar los mismos puertos porque se ejecutan en
hosts distintos. Si el rango `5442x` colisiona con otro proyecto en un mismo
PC, el cambio debe coordinarse y versionarse para todo el equipo; no debe quedar
como una modificación local permanente.

## Valores que faltan configurar manualmente

### 1. Google Cloud Console

1. Crear (o reutilizar) un proyecto en https://console.cloud.google.com.
2. **APIs & Services → OAuth consent screen**: configurar como interno o
   externo según la organización; nombre de la app, dominio autorizado.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   tipo "Web application".
4. **Authorized JavaScript origins** — agregar las dos formas válidas de abrir
   la aplicación local:
   - `http://127.0.0.1:3000`
   - `http://localhost:3000`
5. **Authorized redirect URIs** — agregar la URL de callback de **Supabase**
   (no la ruta `/auth/callback` de esta app):
   - Local en este proyecto: `http://127.0.0.1:54421/auth/v1/callback`.
   - Producción: `https://<tu-project-ref>.supabase.co/auth/v1/callback`.
6. Copiar el **Client ID** y el **Client Secret** generados.

### 2. Supabase

**Local (`supabase/config.toml`, ya preparado):**
- Copiar `.env.example` a `.env` si ese archivo aún no existe y definir allí
  (nunca commiteado):
  ```
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id de Google>
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<client secret de Google>
  ```
- Mantener en `.env.local` la URL y las claves que consume Next.js. No duplicar
  allí los secretos de Google: Supabase CLI resuelve `env(...)` desde `.env`.
- Confirmar que `enabled = true` en `supabase/config.toml` →
  `[auth.external.google]` (ya está habilitado en la configuración actual).
- Reiniciar la pila local para que tome la configuración nueva.

**Producción (Supabase Dashboard, fuera de este repo):**
- Authentication → Providers → Google → Enabled.
- Pegar el mismo Client ID / Client Secret de Google Console.
- Confirmar la **Callback URL** que Supabase muestra ahí — debe coincidir
  exactamente con la que se autorizó en Google Console (paso 4 arriba).
- Confirmar el **Site URL** / **Redirect URLs** del proyecto incluyen el
  dominio real de producción de esta app (para que `redirectTo` en
  `loginWithGoogle()` sea aceptado).

Referencias oficiales: [configuración y secretos de Supabase
CLI](https://supabase.com/docs/guides/local-development/managing-config) y
[Google OAuth con Supabase](https://supabase.com/docs/guides/auth/social-login/auth-google).

## No incluido / no inventado

- Sin "Recordarme": no existe esa opción en la sesión actual (Supabase Auth
  ya maneja duración de sesión vía `jwt_expiry`/refresh token; no hay una
  casilla de usuario que lo controle).
- Sin "¿Olvidaste tu contraseña?": no existe flujo de recuperación de
  contraseña implementado en este repo.
- Sin manejo especial de "usuario nuevo de Google sin rol" más allá del
  rebote a `/login` ya descrito — no se inventó una pantalla de "solicita
  acceso" ni un flujo de aprobación nuevo.
