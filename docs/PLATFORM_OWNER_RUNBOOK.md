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

Eso define todo lo que sigue: el respaldo del OWNER es un **segundo factor TOTP**
guardado fuera del teléfono.

## 2. Lo que el OWNER debe tener antes de activar el bloqueo

1. **Dos factores TOTP verificados** en `/seguridad/mfa`.
   - El primero, en el teléfono de uso diario.
   - El segundo, con su código QR o su secreto **impreso en papel** y guardado
     en un lugar físico seguro. No en el mismo teléfono, no en el mismo gestor
     de contraseñas que ya protege la contraseña de la cuenta: un respaldo que
     se pierde junto con lo que respalda no es un respaldo.
2. **Credenciales del panel de Supabase** (login separado del de la aplicación),
   guardadas con el mismo criterio.

Confirmación de que los dos factores quedaron activos:

```sql
select user_id, friendly_name, status
from auth.mfa_factors
where status = 'verified'
order by user_id, created_at;
```

El `user_id` del OWNER debe aparecer **dos veces**.

## 3. Si el OWNER pierde el teléfono

Usar el segundo factor guardado offline. Iniciar sesión normalmente, y en la
pantalla de verificación elegir el autenticador de respaldo en el selector.

Después de entrar, y **el mismo día**:

1. Dar de baja el factor del teléfono perdido en `/seguridad/mfa`.
2. Inscribir un factor nuevo en el teléfono de reemplazo.
3. Volver a tener dos factores verificados antes de cerrar sesión.

Quedarse con un solo factor es quedarse sin respaldo.

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
5. Inscribir **los dos** factores otra vez, incluido el impreso.

### Registrar el incidente

El borrado desde el panel no pasa por la aplicación, así que no deja rastro en
`mfa_events`. Registrarlo a mano, con la sesión del OWNER ya recuperada y en
aal2:

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

Un admin de empresa (`SUPER_ADMIN` / `ADMIN_RRHH` en `company_memberships`) sí
puede reiniciar el factor de otro miembro **de su misma empresa**, y el OWNER
puede hacerlo con cualquiera menos consigo mismo. Eso cubre el caso corriente:
alguien perdió el teléfono y necesita volver a inscribir.

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

1. Desplegar con `MFA_ENFORCEMENT_ENABLED=false`. `/seguridad/mfa` queda
   accesible y nadie está bloqueado todavía.
2. **El OWNER se inscribe primero**, con sus dos factores (sección 2).
3. Se inscriben el gerente y las dos cuentas `ADMIN_RRHH` que aprueban
   licencias.
4. Confirmar que las cuatro cuentas tienen factor verificado con la consulta de
   la sección 2.
5. Recién entonces: poner `MFA_ENFORCEMENT_ENABLED=true` **y aplicar la
   migración `20260904120000_mfa_aal2_for_privileged_rpcs.sql`**, y redesplegar.

> **Por qué la migración va en el paso 5 y no en el 1.** Esa migración agrega la
> guarda `aal2` dentro de los RPC de licencias médicas y de gestión de
> plataforma. Una función de base de datos no lee variables de entorno, así que
> esa guarda **no** obedece a `MFA_ENFORCEMENT_ENABLED` — esa independencia es lo
> que la hace una segunda capa y no una copia de la primera. Aplicarla en el paso
> 1 dejaría al gerente sin poder aprobar licencias antes de haber tenido la
> oportunidad de inscribirse.

## 8. Si el bloqueo causa un incidente

Poner `MFA_ENFORCEMENT_ENABLED=false` y redesplegar. El MFA ya inscrito no se
pierde; solo se deja de exigir mientras se diagnostica.

Eso revierte las dos capas que corren en la aplicación (el gate del middleware y
la guarda de nómina). **No** revierte la guarda dentro de los RPC: para eso hay
que revertir la migración del paso 5. Si el incidente afecta a la aprobación de
licencias o a la administración de la plataforma, es esa migración la que hay que
revertir, no el flag.
