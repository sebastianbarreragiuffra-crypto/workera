# MFA (TOTP) para cuentas privilegiadas — diseño e implementación

Estado: **diseño cerrado, implementado** en la rama `feat/mfa-totp`. Ver la
sección 11 para lo que quedó distinto del texto original y por qué, y
[docs/PLATFORM_OWNER_RUNBOOK.md](PLATFORM_OWNER_RUNBOOK.md) para la operación.
Todas las decisiones de este documento fueron confirmadas por el usuario en
conversación de septiembre 2026. Ver también la entrada de MFA en
`docs/DECISIONS_PENDING.md`.

Este documento es la fuente única de verdad de la implementación. Si una
sesión se interrumpe a mitad, la siguiente continúa desde acá sin volver a
decidir nada.

---

## 1. Qué se construye y por qué

Segundo factor **TOTP** obligatorio para las cuentas cuyo compromiso causa el
mayor daño. Hoy una contraseña filtrada = acceso total con esa identidad. Con
MFA, además hace falta el dispositivo con el generador de códigos.

Se usa el **MFA nativo de Supabase Auth** (`supabase.auth.mfa.*` + el claim
`aal` del JWT). No se implementa TOTP a mano. Métodos disponibles en el SDK
instalado (`@supabase/auth-js` 2.112.3): `enroll`, `challenge`, `verify`,
`challengeAndVerify`, `unenroll`, `listFactors`,
`getAuthenticatorAssuranceLevel`.

**Supabase NO tiene códigos de recuperación de un solo uso.** Su modelo de
recuperación es inscribir más de un factor. Esto define el break-glass del
OWNER (sección 6).

## 2. Decisiones cerradas

| Decisión | Valor |
|---|---|
| Tipo de factor | TOTP únicamente. Nunca SMS/`phone`. |
| App de autenticación | Cualquier app TOTP (Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.). TOTP es estándar RFC 6238; el QR de Supabase funciona con todas. Cada persona elige la suya. |
| Quién lo necesita (hoy) | El **gerente** de ARCOTEX, las **2 cuentas `ADMIN_RRHH`** que aprueban licencias, y el **OWNER de plataforma** (S. Barrera). |
| Quién NO (hoy) | `SUPERVISOR_*`, y los aprobadores/conciliadores de Rendiciones de otras empresas. El gate queda **listo para extenderse sin refactor** (un solo helper, `account_requires_mfa`). |
| Despliegue | **Bloqueo inmediato.** Sin plazo de gracia, ni para cuentas existentes ni para nuevas. Implica despliegue en dos pasos (sección 8). |
| Frecuencia del desafío | **En cada inicio de sesión.** Sin "recordar este dispositivo". Dentro de una sesión activa no se vuelve a pedir. |
| Chequeo en base de datos | **Sí, doble capa.** Los RPC sensibles exigen `aal2` además del gate del middleware. |
| Break-glass del OWNER de plataforma | Un factor TOTP obligatorio, un segundo secreto offline/impreso **recomendado**, y ruta documentada de borrado desde el panel de Supabase. |
| Reseteo del MFA de otra persona | Solo el **OWNER de plataforma** puede resetear a otra identidad. Un administrador tenant no puede borrar factores globales que protegen otras empresas. La cuenta OWNER no se resetea desde la app y nadie se resetea a sí mismo. |
| Cuentas privilegiadas nuevas (post-enforcement) | Mismo bloqueo inmediato. Ven la pantalla de inscripción en su primer login y no pasan de ahí hasta inscribirse. |

## 3. Fuera de alcance (explícito)

- Factor SMS/`phone`.
- WebAuthn / passkeys.
- MFA para `SUPERVISOR_*` (el gate lo soporta, el flag no los incluye).
- "Recordar dispositivo".
- Ajuste fino de rate limiting más allá de lo que trae Supabase (ítem
  separado en `DECISIONS_PENDING.md`).
- Custom access token hook (optimización futura, sección 5).

---

## 4. Modelo de datos

### `profiles.requires_mfa` — NO se agrega
La necesidad de MFA se **deriva del rol**, no se guarda. Evita que se
desincronice. Ver `profileRequiresMfa()` / `session_requires_mfa()`.

### Nueva tabla: `public.mfa_events` (append-only)
```
id           uuid pk default gen_random_uuid()
user_id      uuid not null references auth.users(id)
event_type   text not null check (event_type in
               ('ENROLLED','VERIFY_SUCCESS','VERIFY_FAILURE','UNENROLLED','ADMIN_RESET'))
performed_by uuid references auth.users(id)   -- solo en ADMIN_RESET
factor_id    text
created_at   timestamptz not null default now()
```
RLS:
- SELECT: el propio usuario ve sus eventos; OWNER ve todos; un admin de
  empresa ve los de usuarios de su empresa.
- INSERT: `authenticated` puede insertar solo filas con `user_id = auth.uid()`
  **o** (para `ADMIN_RESET`) con `performed_by = auth.uid()` y autorización de
  reseteo sobre el `user_id` (sección 6).
- UPDATE / DELETE: **nadie**, ni el OWNER. Append-only, verificado en pgTAP.

### Helpers SQL

```sql
-- ¿El rol de este usuario exige MFA? Único lugar donde vive la regla.
-- Hoy: privilegiado del workspace o de la plataforma. Extensible.
create function public.account_requires_mfa(p_user uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from public.profiles p
            where p.id = p_user and p.active
              and p.role in ('SUPER_ADMIN','ADMIN_RRHH'))
    or exists (select 1 from public.platform_memberships pm
               where pm.user_id = p_user and pm.active
                 and pm.role in ('OWNER','ADMIN'));
$$;

-- El request actual está a nivel aal2.
create function public.request_is_aal2() returns boolean
  language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- Guarda para RPC: si tu rol exige MFA, tenés que estar en aal2.
-- Si tu rol NO exige MFA, pasás igual -> seguro de agregar en cualquier RPC.
create function public.enforce_mfa_for_privileged() returns void
  language plpgsql stable set search_path = '' as $$
  begin
    if public.account_requires_mfa(auth.uid()) and not public.request_is_aal2() then
      raise exception 'Esta operación requiere verificación de segundo factor (MFA).'
        using errcode = 'P0001';
    end if;
  end;
$$;

-- ¿El usuario actual puede resetear el MFA de p_target?
-- Solo el OWNER de plataforma puede resetear a otra persona. El factor
-- pertenece a la identidad global de Auth, no a una membresía tenant.
-- La cuenta OWNER nunca se resetea desde la aplicación.
create function public.can_reset_mfa_for(p_target uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select
    p_target <> auth.uid()                     -- nunca a uno mismo
    and not exists (                            -- nadie resetea a un OWNER de plataforma vía app
      select 1 from public.platform_memberships pm
      where pm.user_id = p_target and pm.active and pm.role = 'OWNER'
    )
    and exists (select 1 from public.platform_memberships pm
                join public.profiles p on p.id = pm.user_id and p.active
                where pm.user_id = auth.uid() and pm.active and pm.role = 'OWNER');
$$;
```

### Migración
`ls supabase/migrations | tail -3` y usar un timestamp **posterior** al
último (hoy el último es `20260903100000`). Test pgTAP: continuar la
secuencia (va en `049`).

---

## 5. Gate del middleware (`src/lib/supabase/middleware.ts`)

El middleware ya valida sesión con `getClaims()` (verificación local del JWT).
El claim `aal` viene en ese mismo JWT — chequearlo NO agrega round-trip.

Lógica, después de establecer `isAuthenticated`:

```
enforcement = process.env.MFA_ENFORCEMENT_ENABLED === 'true'
if enforcement and isAuthenticated:
    aal = claims['aal'] ?? 'aal1'
    if aal !== 'aal2':
        // Solo en el camino aal1 (minoría de requests tras el rollout)
        requiresMfa = await supabase.rpc('session_requires_mfa')   // 1 query indexada
        if requiresMfa and pathname not in MFA_ALLOWED_PATHS:
            return redirect('/seguridad/mfa')
```

- `MFA_ALLOWED_PATHS`: `/seguridad/mfa`, `/login`, `/login/mfa`,
  `/auth/callback`, `/auth/confirm`, y los assets. Una cuenta `aal1`
  privilegiada solo puede llegar a esas rutas.
- **No hay entrada `/logout`.** Esta lista la tuvo, y era una ruta que no
  existe: cerrar sesión es la Server Action `logout` de
  `src/app/login/actions.ts`, y una Server Action se postea a la ruta que la
  renderiza. El resultado era que una cuenta privilegiada en `aal1` no tenía
  ninguna forma de cerrar sesión, porque el gate la sacaba de toda página que
  mostrara el botón del shell. La salida son los botones de las dos pantallas
  MFA (`MfaSignOut`), que postean a rutas ya permitidas acá.
- `MFA_ENFORCEMENT_ENABLED` env, **default `false`**. Mismo patrón que
  `WORKERA_SYNC_ENABLED` / `EXPENSE_OCR_ENABLED`. Con `false`, todo el bloque
  se salta (paso 1 del rollout: la pantalla existe, nadie está forzado).
  Rollback de un incidente = poner el flag en `false` y redesplegar.
- `session_requires_mfa()` RPC = `select public.account_requires_mfa(auth.uid())`.
- El middleware **no distingue** "inscribir" de "desafiar". Manda todo a
  `/seguridad/mfa` y esa página decide (tiene factor verificado → pide código;
  no tiene → inscripción).

**Optimización futura (no ahora):** custom access token hook que agregue
`requires_mfa` al JWT → el middleware sería puro-JWT, cero queries. Se
descartó por ahora porque agrega configuración en `config.toml` y en el panel
hosted, y `config.toml` es sensible en el flujo multi-worktree.

---

## 6. Flujos

### 6.1 Inscripción — `/seguridad/mfa`
Server component + client component para el paso interactivo.

1. `listFactors()` → muestra estado actual (factores verificados).
2. "Inscribir autenticador":
   - `enroll({ factorType: 'totp', friendlyName })` → devuelve `totp.qr_code`
     (SVG data URI) y `totp.secret`.
   - Render del QR + el secreto en texto (para entrada manual).
   - Input del primer código de 6 dígitos → `challenge({ factorId })` +
     `verify({ factorId, challengeId, code })`.
   - Éxito → `mfa_events` (ENROLLED). Error de código → mensaje **específico**:
     "El código no es válido. Si acabás de inscribir, revisá que la hora de tu
     teléfono esté en automático." (el desfase de reloj es la causa #1).
3. **Para la cuenta OWNER:** tras inscribir el primero, la página insiste en
   inscribir un **segundo** factor TOTP, con copy que explica: "Guardá este
   segundo código QR / secreto impreso en un lugar físico seguro. Es tu única
   forma de entrar si perdés el teléfono."
4. Un factor `enroll`-ado pero nunca verificado no cuenta (Supabase lo marca
   `unverified`). La página ofrece descartarlo y reintentar.
5. **Con un factor verificado ya inscrito, inscribir otro o dar de baja el
   actual exige `aal2`.** Sin esa condición, una sesión con solo la contraseña
   podría descartar el factor de la persona, inscribir el suyo y subir a
   `aal2`: el bypass completo. La pantalla ya muestra el desafío en vez de esos
   botones, pero la comprobación vive además en las propias Server Actions
   (`mustChallengeBeforeChangingFactors`), porque una Server Action es un
   endpoint y ocultar el botón no la protege. Supabase Auth también rechaza
   ambas operaciones en `aal1`; la guarda existe para que la propiedad no
   dependa de que ese comportamiento del proveedor se mantenga.

### 6.2 Desafío en login — `/login/mfa`
Tras `signInWithPassword` correcto en `src/app/login/actions.ts`:

```
aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
if aalResult.nextLevel === 'aal2' and aalResult.currentLevel !== 'aal2':
    // tiene factor, falta subir de nivel
    redirect('/login/mfa')          // pide código -> challengeAndVerify -> redirect('/')
else if account_requires_mfa and no verified factor:
    redirect('/seguridad/mfa')      // debe inscribirse
else:
    redirect('/')
```

`/login/mfa`: input de código → `challengeAndVerify({ factorId, code })`.
Éxito → `mfa_events` (VERIFY_SUCCESS) → `redirect('/')`. Fallo →
`mfa_events` (VERIFY_FAILURE) + mensaje. Supabase ya limita la tasa de
`verify`; el registro de fallos es la señal de fuerza bruta.

**El login por OAuth decide igual.** `src/app/auth/callback/route.ts` llama a
la misma `resolvePostLoginDestination`. La primera versión redirigía siempre a
`/`, así que una cuenta privilegiada con factor verificado que entraba por
Google no recibía el desafío mientras el bloqueo estaba apagado — justo el
período en que hay que comprobar que el flujo funciona. Con el bloqueo
encendido el middleware la atrapaba igual, pero las dos formas de crear sesión
tienen que tomar la misma decisión y no dos distintas.

### 6.3 Reseteo del MFA de otra persona — server action
`resetUserMfaAction(targetUserId)`:
- Server-only. Usa el cliente **service-role** (patrón ya existente:
  `runRuleEngineWithServiceRole`). Nunca expuesto al cliente.
- Verifica `can_reset_mfa_for(targetUserId)` (sección 4). Si no → 403.
- Verifica que el llamador esté en `aal2` (un admin reseteando MFA es una
  operación sensible).
- `listFactors` del target vía admin API → `deleteFactor` de cada uno.
- Registra `ADMIN_RESET_STARTED` **antes** de borrar el primer factor y después
  `ADMIN_RESET`, `ADMIN_RESET_PARTIAL` o `ADMIN_RESET_FAILED`.
- Pide al OWNER avisar manualmente a la persona afectada mientras el proveedor
  transaccional siga pendiente. No simula un correo que no se envió.
- **No puede** apuntar a `auth.uid()` (ya cubierto por `can_reset_mfa_for`).

### 6.4 Break-glass del OWNER (sin código — procedimiento)
Documentado en `docs/PLATFORM_OWNER_RUNBOOK.md` (crear):
1. Primera opción: usar el **segundo factor TOTP** guardado offline.
2. Si ambos se perdieron: entrar al **panel de Supabase** (login separado del
   de la app, credencial que solo tiene el OWNER) → tabla `auth.mfa_factors`
   → borrar las filas del `user_id` del OWNER. Próximo login pedirá inscripción
   de nuevo.
3. Registrar el incidente manualmente en `mfa_events` si se pudo.

---

## 7. RPC con chequeo `aal2` en base de datos

Agregar `perform public.enforce_mfa_for_privileged();` como **primera línea**
(después de la validación de rol existente) en:

- `approve_medical_license`, `reject_medical_license`
- Los RPC de gestión de plataforma (`20260901121000_platform_management_rpcs.sql`)
- La generación de lote de nómina (si es RPC; si es lógica de app, el gate va
  en `requirePayrollAccess`)

**No** agregarlo a `reconcile_expense_report` ni a RPC cuyos llamadores están
fuera del conjunto que exige MFA — `enforce_mfa_for_privileged()` es seguro
igual (deja pasar a quien no exige MFA), pero agregarlo donde no aporta solo
suma ruido. Regla: agregarlo donde **todos** los llamadores legítimos ya están
en el conjunto MFA.

pgTAP (`049`):
- `enforce_mfa_for_privileged`: llamador MFA-requerido + `aal1` → excepción;
  + `aal2` → pasa; llamador NO MFA-requerido + `aal1` → pasa.
- Cada RPC endurecido: mismo patrón. Setear `request.jwt.claim.aal` en el test.
- `mfa_events` es append-only: `throws_ok` en UPDATE y DELETE, incluso como
  OWNER / postgres.
- `can_reset_mfa_for`: OWNER puede a un tercero, no a sí mismo ni a otro OWNER;
  un administrador tenant no puede borrar factores globales.

---

## 8. Rollout (bloqueo inmediato, dos pasos)

1. **Desplegar con `MFA_ENFORCEMENT_ENABLED=false`.** `/seguridad/mfa` es
   accesible. Avisar a las 4 cuentas (OWNER + gerente + 2 RRHH).
2. **El OWNER se inscribe primero:** un factor TOTP obligatorio. Se recomienda
   fuertemente un segundo secreto impreso y guardado físicamente para evitar
   depender del break-glass. Confirmar en la base:
   `select user_id, status from auth.mfa_factors where status = 'verified';`
3. Gerente y 2 RRHH se inscriben y verifican.
4. Confirmar que las 4 aparecen con un factor `verified`.
5. En una ventana de mantenimiento, aplicar el segundo corte que contiene la
   migración AAL2 no inerte, poner `MFA_ENFORCEMENT_ENABLED=true` y redesplegar.
   Mantener el tráfico bloqueado hasta verificar ambas capas según
   `docs/PLATFORM_OWNER_RUNBOOK.md`, sección 7.
6. Desde ese momento: toda sesión privilegiada en `aal1` → rebota a
   `/seguridad/mfa` y los RPC privilegiados también rechazan `aal1`.

**Incidente:** bajar el flag solo desactiva las capas de aplicación; las guardas
SQL de los RPC permanecen activas. El rollback de emergencia es hacia adelante:
seguir el procedimiento break-glass de `docs/PLATFORM_OWNER_RUNBOOK.md`, sección
8, que redefine temporalmente `enforce_mfa_for_privileged()` como no-op y luego
restaura su cuerpo seguro. No revertir migraciones ni asumir que el flag basta.

---

## 9. Etapas de implementación (cada una es un commit válido y seguro)

El flag `MFA_ENFORCEMENT_ENABLED` es lo **último** para las capas de aplicación.
La etapa F es deliberadamente **no inerte**: al aplicar su migración, los RPC
privilegiados exigen `aal2` aunque el flag esté apagado. Por eso A–E, G y H se
despliegan primero, se inscriben las cuentas y F se aplica solo en el segundo
corte controlado del runbook. La única excepción es el fallback aprobado por el
OWNER que aplica las cinco migraciones de master juntas; antes de usarlo debe
estar preparado y revisado el rollback forward-only de la sección 8 del runbook.

- **A. Base:** migración con `mfa_events`, los 5 helpers SQL, RLS append-only.
  pgTAP `049`. RPC `session_requires_mfa`.
- **B. Helper de app:** `profileRequiresMfa(profile)` puro + su test. El
  helper `MFA_ALLOWED_PATHS`.
- **C. Página `/seguridad/mfa`:** inscripción + gestión + doble factor para
  OWNER.
- **D. Desafío de login:** `/login/mfa` + cambios en `login/actions.ts`.
- **E. Gate del middleware:** detrás de `MFA_ENFORCEMENT_ENABLED` (default
  `false`).
- **F. `aal2` en RPC:** `enforce_mfa_for_privileged()` en los RPC de la
  sección 7 + pgTAP.
- **G. Reseteo:** `resetUserMfaAction` + email + UI mínima en la ficha de
  usuario. pgTAP de `can_reset_mfa_for`.
- **H. Runbook:** `docs/PLATFORM_OWNER_RUNBOOK.md` (break-glass) + actualizar
  `DECISIONS_PENDING.md`.

## 10. Validación

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
npx supabase test db   # solo con instancia local aislada (ver LOCAL_SETUP.md)
```

Referencia previa: 736 tests TS, 890 pruebas pgTAP en 48 archivos.

---

## 11. Estado de implementación

Las ocho etapas de la sección 9 están construidas. Lo que sigue registra
únicamente aquello en lo que la implementación se apartó del texto de arriba,
para que la próxima sesión no lo lea como una desviación accidental.

### Decisiones consultadas y confirmadas

- **`mfa_events.user_id` / `performed_by` referencian `public.profiles(id)`**, no
  `auth.users(id)`. El repositorio descartó explícitamente ese tipo de FK en
  `20260817152004_auth_roles_and_helpers.sql` porque los fixtures de prueba
  crean profiles sin fila en `auth.users`; hay 49 FKs contra profiles y ninguna
  contra auth.users. Para toda cuenta real el trigger `handle_new_auth_user`
  garantiza `profiles.id = auth.users.id`.
- **El aviso por correo del reseteo no se implementó como envío.** El proyecto
  no tiene correo transaccional. Siguiendo el criterio ya vigente para
  invitaciones, el reseteo queda registrado y la pantalla pide avisar a la
  persona; no se simula un envío que no ocurre.

### Ajustes de implementación

- **`MFA_ALLOWED_PATHS` incluye `/login/mfa`**, que la sección 5 no lista. Sin
  esa entrada, el redirect al desafío que exige la sección 6.2 nunca llegaría a
  destino con el flag activo.
- **`request_is_aal2()` lee el nivel desde `auth.jwt()` y, si no está, desde
  `request.jwt.claim.aal`.** Es el mismo patrón de doble origen de `auth.uid()`
  de Supabase; `auth.jwt()` no lee el GUC individual, así que sin esto las
  pruebas no podrían fijar el nivel.
- **`enforce_mfa_for_privileged()` y `session_requires_mfa()` son SECURITY
  DEFINER.** Es plumbing de privilegios, no autorización: necesitan llamar a
  `account_requires_mfa()`, que es interna. `auth.uid()` y `auth.jwt()` leen
  parámetros de la sesión y no cambian con el dueño de la función.
- **Cada función nueva lleva un `revoke ... from public, anon, authenticated`
  explícito.** `alter default privileges` no retira el EXECUTE que PostgreSQL
  concede a PUBLIC sobre toda función nueva; sin el revoke,
  `account_requires_mfa()` quedaba disponible para cualquier sesión.
- **La pantalla `/seguridad/mfa` vive fuera de `(app)` y `(platform)`.** El
  layout de `(app)` exige `profile.role`, y la cuenta OWNER puede no tenerlo:
  ahí adentro, el gate la mandaría a una ruta que su propio layout devuelve al
  login.
- **El redirect del login a la pantalla de inscripción respeta
  `MFA_ENFORCEMENT_ENABLED`**, aunque la sección 6.2 no lo pide. Sin eso, el
  paso 1 del rollout ya cambiaba lo que ven las cuatro cuentas privilegiadas al
  entrar, antes de que se les avisara. El flag gobierna la obligación de
  inscribirse, no el desafío: a quien YA tiene un factor verificado se le sigue
  pidiendo el código con el flag apagado, porque se inscribió a propósito y es
  lo que permite comprobar que el flujo entero funciona antes de encender el
  bloqueo.
- **La guarda de nómina respeta `MFA_ENFORCEMENT_ENABLED`; la de los RPC no.**
  Una función de base de datos no lee variables de entorno. Las dos capas que
  corren en la aplicación se encienden con el mismo interruptor; la de base de
  datos se enciende al aplicar su migración, que **por eso va en el paso 5 del
  rollout de la sección 8, no en el paso 1**. Aplicarla antes deja al gerente
  sin aprobar licencias antes de haber podido inscribirse.
- **El módulo de reseteo vive en `src/lib/admin/`.** La allowlist que controla
  quién puede alcanzar `createAdminClient` es por directorio, y `src/lib/auth/`
  también contiene módulos puros que no deben poder alcanzarlo.

### Dos hallazgos ajenos a MFA, corregidos aparte

Ambos son la misma clase de error: una función de identidad/rol que devuelve
**NULL** en vez de `false`, combinada con `if not funcion() then raise
exception`, que en PL/pgSQL trata NULL igual que false y nunca lanza la
excepción. Ninguno lo introdujo esta rama; los dos se corrigieron en
`20260904150000_null_authorization_guard_fixes.sql` y se prueban en
`supabase/tests/050_null_authorization_guard_fixes.sql`.

1. **`can_manage_platform()`.** Las guardas de siete RPC vigentes (no solo los
   seis de gestión de plataforma que MFA endureció con `aal2`; también
   `platform_mark_company_invitation_delivery` y las dos versiones de
   `platform_set_company_module_status`) se apoyaban en esta función, que
   devolvía NULL cuando la cuenta no tenía membresía de plataforma. Se verificó
   que un `SUPERVISOR_PRODUCTION` sin membresía lograba crear una empresa y
   dejar su fila de auditoría. Encontrado al verificar el orden de las dos
   guardas en la etapa F.

2. **`is_super_admin()` y las otras tres funciones de identidad exacta de
   rol** (`is_admin_rrhh`, `is_supervisor_production`,
   `is_supervisor_installation`). `current_user_role() = 'ROL'` devuelve NULL
   para cualquier cuenta con `profiles.role IS NULL` -- el estado por defecto
   de TODA cuenta recién registrada (`handle_new_auth_user`: "role = NULL sin
   acceso hasta que un ADMIN_RRHH asigne un rol explícito"). Este es el más
   severo de los dos: se verificó que `cleanup_demo_data()` -- otorgada a
   `authenticated`, guardada solo por `if not public.is_super_admin() then
   raise` -- se ejecutaba hasta el final para cualquier cuenta apenas
   registrada, sin necesitar ningún privilegio. Encontrado al buscar el mismo
   patrón en el resto de la base antes de dar por cerrado el primero.
   `is_privileged_admin()` se corrige de forma transitiva -- es
   `is_super_admin() or is_admin_rrhh()`, y el OR de dos valores que ya nunca
   son NULL nunca es NULL. `is_corporate_user()` no se tocó: usa
   `current_user_role() is not null`, que nunca es NULL en sí mismo.
