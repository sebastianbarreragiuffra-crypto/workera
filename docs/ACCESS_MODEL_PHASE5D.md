# Modelo de accesos — Fase 5D (SUPER_ADMIN + 4 tipos de rol)

Estado: `IMPLEMENTED` a nivel de base de datos (RLS) y de backend server-only (gestión de usuarios). Verificado con 39 pruebas pgTAP nuevas (251/251 totales) y las 212 preexistentes sin modificar. **Sin UI todavía** — ver sección final.

**Advertencia obligatoria**: `SUPER_ADMIN` administra **esta aplicación web** (Workera Supervisor App) — usuarios, roles, configuración, correcciones auditadas, cierre/reapertura de períodos. `SUPER_ADMIN` **no es** un administrador de la cuenta de Workera ni de su API — son dos sistemas separados y no deben confundirse (ver sección 7).

## 1. Cuatro TIPOS de rol, no cuatro cuentas hardcodeadas

`public.app_role` (enum Postgres) tiene exactamente estos 4 valores — ni más, ni `ADMIN`/`OWNER`/`ROOT`:

| Rol | Significado de negocio |
|---|---|
| `SUPER_ADMIN` | Administrador total de la aplicación / propietario técnico del sistema |
| `ADMIN_RRHH` | Usuario de Recursos Humanos |
| `SUPERVISOR_PRODUCTION` | Jefe de Producción |
| `SUPERVISOR_INSTALLATION` | Jefe de Instalación |

El enum define **tipos** de acceso — cuántas cuentas existan de cada tipo es un dato en `profiles`, no un cambio de esquema. Hoy existen (o existirán, ver sección 6) exactamente 4 cuentas, una por tipo; el modelo soporta agregar más sin ninguna migración adicional.

## 2. Helpers de autorización (RLS)

- `is_super_admin()` — chequeo de identidad exacta: ¿el usuario actual es `SUPER_ADMIN`?
- `is_admin_rrhh()` — sin cambios: chequeo de identidad exacta, ¿es `ADMIN_RRHH`? Nunca devuelve `true` para un `SUPER_ADMIN` (sería engañoso).
- `is_privileged_admin()` — **nuevo**, el gate administrativo real: `is_super_admin() OR is_admin_rrhh()`. Reemplaza a `is_admin_rrhh()` en toda policy RLS que antes representaba "acceso administrativo amplio" — `SUPER_ADMIN` hereda automáticamente todo lo que ya tenía `ADMIN_RRHH` en esas tablas, sin duplicar la condición `OR` en cada policy.
- `can_manage_employee(employee_id)` — redefinido para componer sobre `is_privileged_admin()` en vez de `is_admin_rrhh()` directamente; mismo comportamiento previo para `ADMIN_RRHH`, ahora también compone `SUPER_ADMIN`.

## 3. Matriz de accesos

`R` = lectura amplia · `W` = escritura administrativa amplia · `S` = scoped a su grupo (Producción/Instalación) · `—` = sin acceso vía la aplicación (incluye `SUPER_ADMIN`, cuando aplica)

| | SUPER_ADMIN | ADMIN_RRHH | SUPERVISOR_PRODUCTION | SUPERVISOR_INSTALLATION |
|---|---|---|---|---|
| Workers (`employees`) | R/W | R/W | R | R |
| Attendance (`attendance_records`, crudo Workera) | R, **nunca W** | R, **nunca W** | R | R |
| Overtime (`overtime_decisions`) | R/W | R/W | S (solo Producción) | S (solo Instalación) |
| Late arrival (`late_arrival_decisions`) | R/W | R/W | S | S |
| Absence (`absence_records`/`absence_decisions`) | R/W | R/W | S | S |
| Documents (`supporting_documents`) | R/W | R/W | Insert scoped, sin SELECT directo (vía `supporting_documents_metadata`) | ídem |
| Corrections (`attendance_corrections`) | R/W (admin) | R/W (admin) | Insert scoped | Insert scoped |
| Bonuses (`employee_daily_bonuses`) | R (nunca INSERT/UPDATE — automático) | R (ídem) | — | — |
| Weekly review | R/W (cerrar/reabrir) | R/W (cerrar/reabrir) | R/W (transición no CLOSED/REOPENED) | ídem |
| Periods (`reporting_periods`) | R/W (abrir/cerrar/reabrir) | R/W (ídem) | R | R |
| Exports (`excel_exports`) | R/W | R/W | — | — |
| Audit (`audit_log`) | R, **nunca UPDATE/DELETE** | R, **nunca UPDATE/DELETE** | — | — |
| Users (`profiles`, gestión de cuentas) | R/W total (incluye SUPER_ADMIN) | R/W excepto tocar la cuenta SUPER_ADMIN | Solo su propio perfil | Solo su propio perfil |
| Roles (asignar/cambiar) | Cualquier rol, incluido SUPER_ADMIN | Cualquier rol EXCEPTO SUPER_ADMIN | — | — |
| Assignments (`supervisor_assignments`, etc.) | R/W | R/W | R | R |
| Configuration (catálogos, políticas) | R/W | R/W | R | R |

## 4. Principio de seguridad — SUPER_ADMIN no es destructivo

`SUPER_ADMIN` significa control total **sobre la aplicación**, nunca permiso para destruir trazabilidad. Estructuralmente, ni siquiera `SUPER_ADMIN` puede:

- **Sobrescribir marcaciones originales de Workera**: `attendance_records` no tiene ninguna policy de escritura para `authenticated`, sin excepción — verificado por `has_table_privilege` en pgTAP (`024_super_admin_and_access_model.sql`). La única vía de escritura es `service_role` (sincronización futura, Fase 6), que nunca se expone al navegador.
- **Borrar `audit_log`**: el trigger `enforce_immutable_columns()` (Fase 3) bloquea `UPDATE`; nunca hubo `GRANT DELETE` (`grants_lockdown`, Fase 3). Ninguno de los dos se tocó en esta fase.
- **Alterar snapshots históricos de forma destructiva**: `weekly_review_snapshots`/`period_snapshots` siguen sin policy de `UPDATE`/`DELETE` para `authenticated`.
- **Modificar registros fuente de Workera directamente**: ídem `attendance_records`.
- **Eliminar historial de decisiones para ocultar cambios**: `overtime_decisions`/`late_arrival_decisions`/`absence_decisions`/`attendance_corrections` siguen siendo append-only (solo `is_current` es mutable, trigger de inmutabilidad ya existente desde Fase 2A/3) — un `SUPER_ADMIN` puede invalidar la vigente (mismo mecanismo que ya tenía `ADMIN_RRHH`), nunca editar ni borrar una fila.

Las correcciones de marcaciones siguen usando exclusivamente `attendance_corrections` (Gate D), preservando `original`/`correction`/`reason`/`actor`/`timestamp`.

## 5. Gestión de usuarios (backend server-only, sin UI)

`src/lib/supabase/admin-client.ts` — cliente `service_role`, `server-only`, exclusivo para la API de administración de Supabase Auth (`auth.admin.createUser`). Nunca decide autorización por sí mismo.

`src/lib/admin/user-management.ts` — capa de servicios sobre lo anterior:

- `listAppUsers()` — requiere `SUPER_ADMIN` o `ADMIN_RRHH` (verificado contra la sesión real, no el admin client).
- `createAppUser({ email, displayName, role, temporaryPassword? })` — crea la cuenta vía `service_role`; la asignación de rol se escribe a través de la **sesión normal** (sujeta a la misma RLS de `profiles_update`, incluida la protección de `SUPER_ADMIN`) — nunca se duplica la lógica de autorización. Crear un `SUPER_ADMIN` nuevo exige que el actor ya sea `SUPER_ADMIN` (revalidado explícitamente, defensa en profundidad).
- `assignRole(userId, role)` / `setUserActive(userId, active)` — delegan enteramente en la RLS de `profiles_update`.

Toda la autorización real vive en una sola fuente de verdad: la RLS de `profiles`. El backend de gestión de usuarios es una capa de conveniencia, no un mecanismo de autorización paralelo.

## 6. Cuatro cuentas iniciales

Sin emails reales ni contraseñas en Git — ninguna migración siembra cuentas. La arquitectura permite crear administrativamente las 4 cuentas iniciales (una por rol) vía `createAppUser()` una vez exista un primer `SUPER_ADMIN`. El **bootstrap del primer `SUPER_ADMIN`** sigue el mismo criterio ya documentado para el primer `ADMIN_RRHH` desde Fase 3: proceso manual vía acceso directo a la base (SQL/dashboard), documentado explícitamente como tal — no automatizado, porque no existe una cuenta administradora previa que pueda crearlo a través de la RLS normal (problema del huevo y la gallina inherente a cualquier bootstrap de sistema de roles).

Autenticación: email + password vía Supabase Auth. Sin signup público (sin policy de `INSERT` para `authenticated` sobre `profiles` — la única vía es el trigger `on_auth_user_created`, con `role = NULL` siempre).

## 7. Workera vs. Supabase Auth — dos sistemas separados

- **Workera API** (Fase 5C): integración máquina-a-máquina, autenticada con `WORKERA_API_USER`/`WORKERA_API_KEY`, **read-only**. No determina ni participa en ningún rol de la aplicación.
- **Supabase Auth**: usuarios humanos de la web app, autenticados con email+password, con un `app_role` de los 4 confirmados.

Ningún dato ni credencial de un sistema se usa para autorizar en el otro.

## 8. Protección del último SUPER_ADMIN

Trigger `prevent_last_super_admin_removal` (`BEFORE UPDATE` en `profiles`): si la fila modificada es hoy un `SUPER_ADMIN` activo y el cambio la dejaría de serlo (cambio de rol, o `active=false`), y no queda ningún otro `SUPER_ADMIN` activo, la operación se rechaza explícitamente (`P0001`) — verificado con 2 `SUPER_ADMIN` de fixture: degradar uno es permitido, degradar el último restante es rechazado. `DELETE` no requiere protección equivalente: `profiles` nunca tuvo policy de `DELETE` para `authenticated`.

## 9. Prevención de escalamiento de privilegios — verificado

- `SUPERVISOR_PRODUCTION`/`SUPERVISOR_INSTALLATION` → intento de auto-asignarse `SUPER_ADMIN`: bloqueado por `USING` (0 filas afectadas, la fila ni siquiera es visible para el `UPDATE`).
- `ADMIN_RRHH` → intento de auto-asignarse `SUPER_ADMIN`: bloqueado por `WITH CHECK` (el `UPDATE` sí toca la fila pero el valor nuevo se rechaza — lanza `42501` explícito).
- `ADMIN_RRHH` → intento de modificar la cuenta `SUPER_ADMIN` existente (ej. desactivarla): bloqueado por `USING` (0 filas afectadas).
- Un supervisor → intento de cambiar el rol de OTRO usuario: bloqueado por `USING`.
- `SUPER_ADMIN` → asignar cualquier rol permitido, incluido crear `ADMIN_RRHH`/supervisor: verificado `PASS`.

## 10. Lo que esta fase NO hace

- No construye ningún dashboard, panel visual, ni layout.
- No sincroniza datos de Workera hacia Supabase (Fase 6).
- No implementa `POST`/`PUT`/`DELETE` contra Workera (sigue siendo read-only).
- No expone `SUPABASE_SERVICE_ROLE_KEY` al navegador (verificado con tests automatizados, mismo criterio que Fase 4 para las credenciales de Workera).
