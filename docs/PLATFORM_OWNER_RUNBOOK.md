# Runbook de la cuenta OWNER de plataforma

Estado: **vigente**. Procedimiento operativo, no diseño. Las decisiones que lo
sustentan están en [docs/MFA_DESIGN.md](MFA_DESIGN.md); acá solo está qué hacer
y en qué orden.

Este documento existe porque hay exactamente una cuenta que, si se pierde, deja
a GESTORA sin administrador. La protección de "último OWNER activo" ya existe en
la base de datos, pero protege contra *desactivar* al último OWNER, no contra
*perder el acceso* a su cuenta.

---

## 1. Por qué no hay códigos de recuperación

Supabase Auth **no** tiene códigos de respaldo de un solo uso. Su modelo de
recuperación es inscribir más de un factor. Cualquier documento anterior que
mencione "códigos de respaldo impresos" para esta aplicación describe algo que
el proveedor no ofrece.

Por eso se recomienda que el respaldo del OWNER sea un **segundo factor TOTP**
guardado fuera del teléfono. La aplicación exige al menos uno; el segundo evita
depender del procedimiento break-glass.

## 2. Preparación recomendada antes de activar el bloqueo

1. **Un factor TOTP verificado** en `/seguridad/mfa` y, como recuperación
   recomendada, un segundo factor.
   - El primero, en el teléfono de uso diario.
   - El segundo, con su código QR o su secreto **impreso en papel** y guardado
     en un lugar físico seguro. No en el mismo teléfono, no en el mismo gestor
     de contraseñas que ya protege la contraseña de la cuenta: un respaldo que
     se pierde junto con lo que respalda no es un respaldo.
2. **Credenciales del panel de Supabase** (login separado del de la aplicación),
   guardadas con el mismo criterio.

Confirmación de los factores activos:

```sql
select user_id, friendly_name, status
from auth.mfa_factors
where status = 'verified'
order by user_id, created_at;
```

El `user_id` del OWNER debe aparecer al menos una vez; dos filas confirman que
también se preparó el respaldo recomendado.

## 3. Si el OWNER pierde el teléfono

Usar el segundo factor guardado offline. Iniciar sesión normalmente, y en la
pantalla de verificación elegir el autenticador de respaldo en el selector.

Después de entrar, y **el mismo día**:

1. Dar de baja el factor del teléfono perdido en `/seguridad/mfa`.
2. Inscribir un factor nuevo en el teléfono de reemplazo.
3. Volver a crear el factor principal y, de ser posible, el respaldo antes de
   cerrar sesión.

Un solo factor cumple el bloqueo, pero deja la recuperación dependiente del
panel de Supabase.

## 4. Break-glass: si se perdieron los dos factores

Esta es la única ruta de recuperación y no pasa por la aplicación.

1. Entrar al **panel de Supabase** del proyecto con la credencial que solo tiene
   el OWNER.
2. Abrir la tabla `auth.mfa_factors`.
3. Borrar las filas cuyo `user_id` sea el del OWNER.

   ```sql
   delete from auth.mfa_factors
   where user_id = '<user_id del OWNER>';
   ```

   Borrar **solo** esas filas. Un `delete` sin `where` deja sin segundo factor a
   toda la plataforma.
4. Iniciar sesión en la aplicación. Como la cuenta ya no tiene factores
   verificados, el gate la manda a `/seguridad/mfa` a inscribir de nuevo.
5. Inscribir el factor principal y, como recomendación de recuperación, volver
   a crear también el respaldo impreso.

### Registrar el incidente

El borrado desde el panel no pasa por la aplicación, así que no deja rastro en
`mfa_events`. Registrarlo a mano desde el SQL Editor de Supabase, cuya sesión
administrativa es una frontera confiable:

```sql
insert into public.mfa_events (user_id, event_type, factor_id)
values ('<user_id del OWNER>', 'UNENROLLED', 'break-glass-panel-supabase');
```

La bitácora es append-only: si este registro no se hace en el momento, después
no hay forma de insertarlo con la fecha real.

## 5. Por qué la aplicación no puede resetear al OWNER

`can_reset_mfa_for()` excluye explícitamente a cualquier cuenta con membresía
`OWNER` activa, **incluso para otro OWNER y aunque compartan empresa**. Es
deliberado: si la aplicación pudiera reiniciar el segundo factor del
administrador de la plataforma, ese camino sería el eslabón más débil de todo el
esquema. El precio es este runbook.

El factor pertenece a la identidad global de Auth y puede abrir acceso a más
de una empresa. Por eso un admin tenant no puede reiniciarlo: solo el OWNER de
plataforma puede hacerlo con otra persona. El reseteo queda registrado antes y
después de tocar la API de Auth.

## 6. Habilitar el proveedor TOTP

Antes de que nadie pueda inscribir nada, Supabase Auth tiene que permitir TOTP.
Viene **deshabilitado** por defecto y no es algo que el código pueda encender.

- **Local:** ya está en `supabase/config.toml`, en `[auth.mfa.totp]`, con
  `enroll_enabled` y `verify_enabled` en `true`. Toma efecto al reiniciar la
  pila (`npx supabase stop && npx supabase start`).
- **Staging y producción:** hay que habilitarlo en el panel del proyecto, en
  Authentication → Multi-Factor Authentication, o empujando la configuración con
  el CLI. `config.toml` solo gobierna la pila local.

El factor por SMS queda deshabilitado a propósito y no debe habilitarse: el
diseño descarta `phone` explícitamente.

Si `enroll()` devuelve un error de proveedor no habilitado, es esto y no un
problema de la aplicación.

## 7. Secuencia de activación del bloqueo

El orden importa y no es intercambiable.

> **Bloqueo operativo del repositorio actual.** `master` y
> `codex/phases2-6-autonomous` ya contienen tanto la fundación MFA como la
> migración AAL2 no inerte y migraciones posteriores. Por lo tanto, **no se debe
> ejecutar un `supabase db push` completo desde esas ramas durante el paso 1**:
> bloquearía los RPC antes de que las cuentas se inscriban. Preparar una rama de
> despliegue temporal que contenga únicamente estas migraciones pendientes:
> `20260903100000_medical_license_range_bound.sql`,
> `20260903140000_mfa_totp_foundation.sql`,
> `20260904150000_null_authorization_guard_fixes.sql` y
> `20260904160000_mfa_security_hardening.sql`. Las dos últimas son inertes para
> el enforcement, pero son obligatorias antes de inscribir: cierran guards que
> devolvían `NULL` y permiten que `service_role` escriba la bitácora MFA. Excluir
> expresamente `20260904120000` y todo lo posterior a `20260904160000` de ese
> primer corte. Inscribir las cuatro cuentas y recién en el paso 5 aplicar el
> resto con `supabase db push --include-all` (primero `--dry-run`), porque la
> migración `20260904120000` tendrá un timestamp anterior a dos versiones ya
> registradas. La segunda tanda debe incluir
> `20260904224000_mfa_module_catalog_integration.sql`, que conserva AAL2 sin
> reintroducir el caso especial de Rendiciones en el control plane.

1. Desplegar con `MFA_ENFORCEMENT_ENABLED=false`. Este paso es **invisible**:
   `/seguridad/mfa` queda accesible para quien entre a propósito, pero nadie es
   redirigido ahí ni bloqueado. Avisar a las cuatro cuentas por fuera de la
   aplicación y pasarles el enlace.

   Desde el momento en que una de ellas inscribe y verifica su factor, sus
   siguientes inicios de sesión sí le van a pedir el código, con el flag todavía
   apagado. Es a propósito: es la única forma de comprobar que el flujo completo
   funciona antes del paso 5.
2. **El OWNER se inscribe primero**, con su factor obligatorio y, de ser
   posible, el respaldo recomendado (sección 2).
3. Se inscriben el gerente y las dos cuentas `ADMIN_RRHH` que aprueban
   licencias.
4. Confirmar que las cuatro cuentas tienen factor verificado con la consulta de
   la sección 2.
5. Recién entonces, dentro de una ventana de mantenimiento: poner
   `MFA_ENFORCEMENT_ENABLED=true`, aplicar el segundo corte completo y
   redesplegar. Mantener el tráfico bloqueado hasta comprobar que
   `20260904224000_mfa_module_catalog_integration.sql` figura aplicada y que la
   definición final de `platform_set_company_module_status()` contiene
   `tenant_isolated` y `enforce_mfa_for_privileged()`, pero no una comparación
   hardcodeada con `expenses`.

> **Por qué la guarda de base de datos no puede ir en el paso 1.**
> `20260904120000_mfa_aal2_for_privileged_rpcs.sql` agrega la guarda `aal2`
> dentro de los RPC de licencias médicas y de gestión de plataforma. Una función
> de base de datos no lee variables de entorno, así que esa guarda **no** obedece
> a `MFA_ENFORCEMENT_ENABLED` — esa independencia es lo que la hace una segunda
> capa y no una copia de la primera. Aplicarla antes de que el gerente haya
> tenido la oportunidad de inscribirse lo deja sin poder aprobar licencias.

### Cómo aplicar las migraciones sin romper ese orden

Esta parte cambió cuando MFA bajó a master y hay que leerla antes de correr
nada. `supabase db push` aplica **todas** las migraciones pendientes en orden de
versión; no existe un "aplicar hasta la versión X". Las cuatro de MFA quedaron
así:

| Migración | Qué hace |
|---|---|
| `20260903140000` | Fundación: `mfa_events`, helpers, RLS. Inerte. |
| `20260904120000` | Guarda `aal2` en los RPC sensibles. **No es inerte.** |
| `20260904150000` | Corrige las guardas de autorización que devolvían NULL. |
| `20260904160000` | Endurecimiento de la bitácora y del reseteo. |

La que no es inerte quedó **en medio**, así que un checkout normal de `master`
no puede aplicar las dos últimas sin aplicar antes la del medio. El procedimiento
preferido es la rama de despliegue temporal descrita al inicio de esta sección:
incluye fundación y hardening, omite solo la guarda AAL2 durante la inscripción y
cierra de inmediato el agujero de las guardas NULL. Después de inscribir, el
segundo corte usa `--include-all` para registrar la migración intermedia y todo
lo posterior en una ventana controlada.

Si no se puede preparar y revisar esa rama temporal, el OWNER puede optar por
aplicar las cinco migraciones pendientes desde `origin/master` de una vez y hacer
que las cuatro personas inscriban su factor ese mismo día. Este camino evita
postergar `20260904150000`, pero crea un bloqueo operacional controlado hasta que
termine la inscripción y **solo se permite si el artefacto de rollback de la
sección 8 ya fue preparado, revisado y está disponible antes del push**. El
antiguo camino de desplegar solo la fundación desde `42325ec` no es recomendable:
deja abierto el bypass de autorización durante la espera.

En cualquiera de los dos casos, las migraciones de master van a staging **antes**
que las de `codex/phases2-6-autonomous`, por la razón explicada en
[STAGING_ENVIRONMENT.md](STAGING_ENVIRONMENT.md).

## 8. Si el bloqueo causa un incidente

Poner `MFA_ENFORCEMENT_ENABLED=false` y redesplegar. El MFA ya inscrito no se
pierde; solo se deja de exigir mientras se diagnostica.

Eso revierte las dos capas que corren en la aplicación (el gate del middleware y
la guarda de nómina), pero no la guarda de los ocho RPC. Antes de cualquier corte
que incluya `20260904120000` debe existir una migración de emergencia revisada,
conservada **fuera** de
`supabase/migrations` para que nunca se aplique automáticamente. El rollback es
hacia adelante: redefine temporalmente el helper compartido, sin reescribir los
ocho RPC ni perder la lógica `tenant_isolated`:

```sql
create or replace function public.enforce_mfa_for_privileged()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return;
end;
$$;
```

Aplicar ese artefacto solo bajo el procedimiento break-glass, registrar el
incidente y verificar que las guardas de rol propias de cada RPC siguen
rechazando usuarios no autorizados. Para reactivar la segunda capa, aplicar otra
migración hacia adelante que restaure exactamente el cuerpo seguro de
`enforce_mfa_for_privileged()` definido en
`20260903140000_mfa_totp_foundation.sql`; nunca depender de revertir únicamente
`20260904120000`, porque `20260904224000` también conserva la llamada AAL2.
