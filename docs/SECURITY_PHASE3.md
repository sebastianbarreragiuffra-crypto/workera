# Seguridad — Fase 3 (Autenticación, roles, permisos y RLS)

Extiende `docs/DATA_MODEL_PHASE2.md` y `docs/DATA_MODEL_PHASE2B.md` con 10 migraciones nuevas (`14` a `24`), sin modificar ninguna de las 13 migraciones de Fase 2A/2B. Principio rector en toda la fase: **UI ≠ seguridad**. Ninguna regla de autorización depende de que el frontend oculte un botón — todas están impuestas por PostgreSQL (privilegios de tabla + RLS), de modo que funcionan incluso si alguien modifica manualmente una request HTTP.

Migraciones de esta fase:

| Migración | Contenido |
|---|---|
| `14_auth_roles_and_helpers` | `app_role` enum, `profiles.role`, trigger `auth.users → profiles`, funciones de autorización (`is_admin_rrhh()`, etc.), RLS de `profiles` |
| `15_attendance_corrections` | Tabla faltante de Fase 2A (ver nota abajo) |
| `16_absence_records_manual_tracking` | `absence_records.created_by` (aditivo) |
| `17_rls_catalogs_and_policies` | RLS de catálogos y tablas de política |
| `18_rls_employees_and_organization` | RLS de `employees` y asignaciones |
| `19_rls_attendance` | RLS de asistencia (source Workera inmutable) |
| `20_rls_overtime_and_lateness` | RLS de horas extra/atrasos |
| `21_rls_absences_and_bonus` | RLS de ausencias y bono |
| `22_rls_reviews_periods_exports_documents_audit` | RLS de revisión/período/exports/documentos/auditoría |
| `23_grants_lockdown` | Revocación y otorgamiento explícito de privilegios de tabla (hallazgo crítico, ver sección "IDOR/BOLA y GRANT") |
| `24_seed_installation_late_arrival_policy` | Completa un vacío de siembra de Fase 2B |

**Nota — dos vacíos de fases anteriores completados en esta fase:** (1) `attendance_corrections` estaba documentada conceptualmente desde Fase 2A pero nunca se había implementado como tabla; el propio encargo de Fase 3 la exige para poder otorgar permisos de escritura de forma segura, así que se creó ahora. (2) `late_arrival_policies` nunca quedó sembrada para `INSTALLATION` porque ese grupo se agregó en Fase 2B, después de que la siembra original (Fase 2A) ya había corrido. Ambos son hallazgos de esta revisión, no cambios de diseño.

---

## 1. Authentication architecture

Supabase Auth, email + password únicamente. Sin Google/Microsoft OAuth, sin magic links, sin login social (encargo sección 20 — "mantener simple"). Sin signup público: no existe ninguna ruta ni UI de registro; las cuentas se crean administrativamente (invitación vía Supabase Auth Admin API o Studio, fuera del alcance de código de esta fase). `src/lib/supabase/{client,server,middleware}.ts` implementan el patrón oficial `@supabase/ssr` para Next.js App Router (Server Components, Route Handlers y Client Components comparten sesión vía cookies; `src/proxy.ts` — convención vigente en Next.js 16, migrada automáticamente desde `middleware.ts` con el codemod oficial — refresca el token en cada request).

## 2. Roles

Exactamente 3, como un enum de Postgres (`app_role`), no texto libre ni catálogo:

```
ADMIN_RRHH
SUPERVISOR_PRODUCTION
SUPERVISOR_INSTALLATION
```

`profiles.role` es **nullable**: un usuario recién autenticado sin configuración administrativa tiene `role = NULL`, que no coincide con ninguna de las 3 comparaciones de rol usadas en toda policy — por lo tanto no tiene absolutamente ningún acceso hasta que un `ADMIN_RRHH` le asigne uno explícitamente (encargo sección 28, confirmado por test `016`).

## 3. Permission matrix

Tabla completa de las 34 tablas + 2 vistas del esquema. "Scoped" = limitado al `employee_group` que administra el supervisor (`PRODUCTION`/`INSTALLATION`), vía `can_manage_employee(employee_id)`. "—" = sin policy, denegado por ausencia de regla (deny-by-default).

| Tabla / vista | ADMIN_RRHH | SUPERVISOR_PRODUCTION | SUPERVISOR_INSTALLATION | anon |
|---|---|---|---|---|
| `profiles` | SELECT todos, UPDATE todos | SELECT propio, UPDATE — | SELECT propio, UPDATE — | — |
| `employee_groups` / `overtime_types` / `absence_types` / `attendance_statuses` / `bonus_types` | SELECT | SELECT | SELECT | — |
| `work_schedules` / `work_schedule_rules` / `overtime_policies` / `late_arrival_policies` / `bonus_policies` | CRUD | SELECT | SELECT | — |
| `employees` | CRUD | SELECT (todos) | SELECT (todos) | — |
| `employee_group_assignments` / `schedule_assignments` / `supervisor_assignments` | CRUD | SELECT | SELECT | — |
| `attendance_records` (source Workera) | SELECT | SELECT | SELECT | — |
| `attendance_corrections` | SELECT, INSERT, UPDATE (is_current) | SELECT, INSERT scoped | SELECT, INSERT scoped | — |
| `attendance_status_records` | SELECT, INSERT, UPDATE (is_current) | SELECT, INSERT scoped (manual) | SELECT, INSERT scoped (manual) | — |
| `sync_runs` | SELECT | — | — | — |
| `overtime_records` / `late_arrival_records` (cálculo) | SELECT | SELECT | SELECT | — |
| `overtime_decisions` / `late_arrival_decisions` | SELECT, INSERT, UPDATE (is_current) | SELECT, INSERT scoped | SELECT, INSERT scoped | — |
| `late_arrival_daily_totals` (vista) | SELECT | SELECT | SELECT | — |
| `absence_records` | SELECT, INSERT, UPDATE (is_current) | SELECT, INSERT scoped (manual) | SELECT, INSERT scoped (manual) | — |
| `absence_decisions` | SELECT, INSERT, UPDATE (is_current) | SELECT, INSERT scoped | SELECT, INSERT scoped | — |
| `employee_daily_bonuses` | SELECT | — | — | — |
| `daily_reviews` | SELECT, UPDATE | SELECT, UPDATE scoped | SELECT, UPDATE scoped | — |
| `weekly_reviews` | SELECT, UPDATE (incl. CLOSE/REOPEN) | SELECT, UPDATE (no CLOSE/REOPEN) | SELECT, UPDATE (no CLOSE/REOPEN) | — |
| `weekly_review_snapshots` / `period_snapshots` | SELECT, INSERT | SELECT | SELECT | — |
| `reporting_periods` | SELECT, INSERT, UPDATE (OPEN/CLOSE/REOPEN) | SELECT | SELECT | — |
| `excel_exports` | CRUD | — | — | — |
| `supporting_documents` (tabla base, incluye storage_path) | SELECT, INSERT, UPDATE | INSERT scoped, SELECT — | INSERT scoped, SELECT — | — |
| `supporting_documents_metadata` (vista, sin storage_path) | SELECT | SELECT (propios/su dominio) | SELECT (propios/su dominio) | — |
| `audit_log` | SELECT, INSERT (propio) | INSERT (propio), SELECT — | INSERT (propio), SELECT — | — |

## 4. RLS strategy

Deny-by-default en las 34 tablas (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + verificación automática al final de la migración `23` que aborta si alguna tabla de `public` quedó sin RLS habilitado — cubre la sección 54 del encargo como chequeo automático, no solo revisión manual).

**Helpers de autorización** (`14_auth_roles_and_helpers.sql`): `current_user_role()`, `is_admin_rrhh()`, `is_supervisor_production()`, `is_supervisor_installation()`, `is_corporate_user()`, `can_manage_employee(uuid)`. Todos `SECURITY DEFINER` con `search_path = ''` (vacío, nombres completamente calificados) — necesario específicamente para evitar el problema conocido de recursión de RLS (una policy de `profiles` que llama a una función que vuelve a consultar `profiles` bajo RLS entraría en bucle si la función no fuera `SECURITY DEFINER`). `EXECUTE` otorgado solo a `authenticated`, nunca a `anon`.

`can_manage_employee(uuid)` es la frontera real de "ver todos ≠ modificar todos" (encargo sección 5/6): compara el rol del usuario actual contra el `employee_group` **actual** del trabajador (`employees.employee_group_id`, no el historial de `employee_group_assignments` — decisión documentada: para decisiones operacionales del día a día corresponde el grupo vigente, no una foto histórica). Deliberadamente **no** usa `supervisor_assignments`: el requisito confirmado es autorización por grupo completo, no por asignación 1:1: esa tabla se mantiene, sigue siendo consultable, y queda disponible para un modelo más fino en una fase futura si el negocio lo pide explícitamente.

## 5. Admin/RRHH permissions

Lectura total. Escritura administrativa completa sobre catálogos de política, `employees` y asignaciones organizacionales. Único rol que puede: invalidar (`is_current = false`) una `OvertimeDecision`/`LateArrivalDecision`/`AbsenceDecision` ya tomada (revisión/override, sección 7-8), abrir/cerrar/reabrir `ReportingPeriod` y `WeeklyReview`, generar/leer `ExcelExport`, leer el contenido completo de `supporting_documents` (incluido `storage_path`), y leer `audit_log`/`sync_runs`/`employee_daily_bonuses`.

## 6. Supervisor Production — read/write/forbidden

**Lectura:** todos los trabajadores de Arcotex (los 3 grupos), asistencia, horas extra, atrasos, ausencias/licencias/vacaciones, decisiones históricas — sin límite de fecha.
**Escritura (scoped a `PRODUCTION` vía `can_manage_employee`):** `OvertimeDecision` (aprobar/rechazar/parcial), `LateArrivalDecision` (justificar + `payroll_effect`), `AttendanceCorrection`, `AbsenceRecord`/`AbsenceDecision` manuales, `SupportingDocument` (solo INSERT de metadata), `DailyReview` (avanzar estado), `WeeklyReview` (avanzar hasta `READY_TO_CLOSE`, nunca `CLOSED`/`REOPENED`).
**Prohibido, confirmado por test:** escalar su propio rol; modificar `attendance_records`/`overtime_records`/`late_arrival_records` (fuente/cálculo) directamente; invalidar una decisión ya tomada (ni la propia); crear/editar un `EmployeeDailyBonus`; cerrar/reabrir `ReportingPeriod`/`WeeklyReview`; leer `supporting_documents` (tabla base) o `audit_log`; actuar sobre trabajadores de `INSTALLATION`.

## 7. Supervisor Installation — read/write/forbidden

Mismo patrón exacto que Producción, scoped a `INSTALLATION`. Las reglas de horas extra de Instalación (fin de semana, HH50/HH100, bono) siguen sin confirmar (`PENDING_BUSINESS_CONFIRMATION`, Fase 2B) — esto no bloqueó la autorización: el supervisor puede operar sobre `OvertimeDecision`/`LateArrivalDecision` de su grupo igual que Producción, la ausencia de política de bono/overtime de fin de semana simplemente significa que el motor de cálculo futuro no generará esos registros todavía para Instalación, no que la autorización esté incompleta.

## 8. Read vs write distinction

`employees` (y por extensión, la posibilidad de *ver* cualquier tabla operacional filtrando por trabajador) tiene `SELECT` amplio para los 3 roles corporativos — confirmado explícitamente por el encargo. La escritura nunca se acopla a esa misma condición: cada policy de `INSERT`/`UPDATE` en tablas operacionales exige además `can_manage_employee(employee_id)` (o `is_admin_rrhh()`). Esto se implementa con **policies separadas** por comando (`_select` amplia + `_insert`/`_update` scoped), nunca una única policy `FOR ALL` que mezclaría ambos criterios — así el scoping de escritura nunca se relaja accidentalmente al ajustar la de lectura, o viceversa.

## 9. Overtime authorization

`OvertimeRecord` (candidato) — sin escritura para `authenticated` bajo ninguna circunstancia, ni admin. `OvertimeDecision`: `INSERT` por el supervisor a cargo del grupo del trabajador (o admin), con `decided_by` forzado a `auth.uid()` vía `WITH CHECK` — nunca confía en el valor enviado por el cliente (confirmado por test: un `decided_by` forjado se rechaza incluso apuntando a un registro real dentro del propio dominio). `UPDATE` (única forma de "modificar": voltear `is_current` a `false`, habilitado por el trigger de inmutabilidad de Fase 2A) exclusivo de `ADMIN_RRHH` — es el mecanismo de REVIEW/OVERRIDE (sección 7-8): la decisión original nunca se borra, queda como historial `is_current = false`. El índice único parcial de Fase 2A (`overtime_decisions_current_key`) ya impide que exista más de una decisión vigente por registro, así que un supervisor no puede "reemplazar" su propia decisión insertando una nueva mientras la anterior siga vigente.

## 10. Late arrival authorization

Mismo patrón exacto que horas extra. `LateArrivalDecision.payroll_effect` (`DEDUCT`/`DO_NOT_DEDUCT`/`NEEDS_REVIEW`) y `justification_status` (columna generada desde `justified`, Fase 2B) los define el supervisor a cargo al crear la decisión; solo `ADMIN_RRHH` puede invalidar una ya tomada.

## 11. Attendance corrections

`attendance_records` (fuente Workera) **no tiene ninguna policy de `UPDATE`/`INSERT`/`DELETE` para `authenticated`, sin excepción — ni siquiera `ADMIN_RRHH`** (confirmado por test `017`: un intento de `UPDATE actual_clock_out` es rechazado por falta de privilegio de tabla, antes incluso de evaluar RLS). Toda corrección pasa por `attendance_corrections` (tabla nueva de esta fase), con `corrected_by` forzado a `auth.uid()`, `reason` obligatorio, e `INSERT` scoped por `can_manage_employee`. `UPDATE` (solo `is_current`) exclusivo de `ADMIN_RRHH`.

## 12. Manual absences

`absence_records`/`attendance_status_records` con `source = 'manual'` exigen `created_by = auth.uid()` vía `WITH CHECK` (confirmado por test `021`: un intento de registrar una novedad fingiendo otro `created_by` es rechazado). Scoped por `can_manage_employee` — un supervisor no puede registrar una licencia para un trabajador fuera de su grupo.

## 13. Document privacy

Postgres RLS filtra **filas**, no columnas — no existe una forma nativa de que dos roles vean columnas distintas de la misma fila vía policies. Solución implementada: `supporting_documents` (tabla base, incluye `storage_path`) con `SELECT` restringido a `ADMIN_RRHH` únicamente; `supporting_documents_metadata` (vista sin la columna `storage_path` en absoluto — confirmado por test que la columna no existe ni oculta) con su propio `WHERE` (`is_admin_rrhh() OR uploaded_by = auth.uid() OR can_manage_employee(employee_id)`), ejecutada con `security_invoker = false` (el valor por defecto) para poder leer la tabla base pese a que su policy es admin-only — el `WHERE` de la vista, no el propietario, es quien decide qué filas devuelve, usando `auth.uid()` real de quien consulta. Un supervisor puede `INSERT` (subir metadata) pero solo `SELECT` vía la vista — nunca ve `storage_path`, confirmado por test `019`.

## 14. ReportingPeriod security

`OPEN`/`REOPEN`/`CLOSE` exclusivo de `ADMIN_RRHH` (`reporting_periods_insert_admin`, `reporting_periods_update_admin`) — regla obligatoria sin excepción, confirmada por test `018`. Al cerrar/reabrir, `closed_by`/`reopened_by` se fuerzan a `auth.uid()` vía `WITH CHECK`.

## 15. Weekly reopen

`weekly_reviews`: cualquier corporativo puede avanzar el estado mientras no sea hacia/desde `CLOSED`/`REOPENED` (participación operacional en el check semanal); cerrar o reabrir exclusivo de `ADMIN_RRHH`, con el mismo forzado de actor. Confirmado por test `018`: un supervisor avanza a `READY_TO_CLOSE` pero no puede transicionar a `CLOSED`.

## 16. Audit protection

`audit_log`: `INSERT` permitido a cualquier corporativo únicamente con `actor_id = auth.uid()` (confirmado por test: forjar el actor es rechazado). `SELECT` restringido a `ADMIN_RRHH` (simplificación explícita de esta fase — el encargo dejaba abierto "supervisor puede tener acceso limitado si es necesario"; se optó por el criterio más conservador). **Sin ninguna policy de `UPDATE`/`DELETE`** para `authenticated`, reforzado además con el mismo trigger de inmutabilidad usado en el resto del esquema (defensa en profundidad: ni un bug de aplicación que de alguna forma obtuviera privilegios de escritura podría alterar una fila ya escrita).

## 17. Role escalation protection

`profiles.role` solo es editable por `is_admin_rrhh()` (`profiles_update_admin_only`) — ni siquiera sobre la propia fila. Confirmado por test `016`: `SUPERVISOR_PRODUCTION` y `SUPERVISOR_INSTALLATION` intentan `UPDATE role = 'ADMIN_RRHH'` sobre sí mismos y sobre otro usuario; en ambos casos la fila queda sin modificar (RLS excluye la fila del `UPDATE`, comportamiento estándar de Postgres: 0 filas afectadas, sin excepción — se verificó explícitamente que el valor no cambió, no solo que la sentencia no arrojó error).

## 18. IDOR/BOLA protection

Test `017`: `SUPERVISOR_INSTALLATION` obtiene el UUID real de un `OvertimeRecord` de un trabajador de `PRODUCTION` (visible porque la lectura es amplia) e intenta aprobarlo — rechazado por RLS pese a ser un UUID completamente válido y existente. Confirma que la protección no depende de que el frontend oculte IDs: **cualquier UUID obtenido legítimamente por lectura amplia sigue sujeto al scoping de escritura**.

## 19. service_role boundaries

`service_role` nunca se usa en ningún archivo bajo `src/` — los dos clientes creados (`src/lib/supabase/client.ts`, `server.ts`) usan exclusivamente `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` sigue declarada solo en `.env.example` (sin prefijo `NEXT_PUBLIC_`, ya correcto desde Fase 1) para uso futuro exclusivamente server-side (sincronización con Workera, Fase 5+) — su ausencia total del código de esta fase es intencional: Fase 3 no la necesita porque ninguna operación de esta fase requiere saltarse RLS.

## 20. Storage future requirements

No implementado (fuera de alcance, sección 54/59-61 del encargo). Documentado para cuando se implemente: bucket **privado** (nunca público), acceso mediante *signed URLs* de corta duración generadas server-side tras verificar `is_admin_rrhh()` (o el scoping correspondiente), nunca URLs permanentes embebidas en `storage_path`. `storage_path` ya está diseñado para no ser legible por supervisores (sección 13), lo cual es la precondición correcta para que, cuando exista Storage real, ni siquiera un supervisor pueda construir una URL de descarga sin pasar por una Route Handler server-side que verifique autorización primero.

## 21. Remaining risks (no resueltos en esta fase, documentados)

- **Privilegios por defecto de tablas futuras**: se confirmó (hallazgo de esta fase) que Supabase concede `TRUNCATE`/`REFERENCES`/`TRIGGER` a `anon`/`authenticated` en toda tabla nueva por defecto, y que `TRUNCATE` **no está sujeto a RLS**. Se corrigió para las 34 tablas existentes (`23_grants_lockdown.sql`), pero cualquier tabla nueva de una fase futura debe repetir el mismo patrón explícito de `REVOKE ALL` + `GRANT` mínimo — no hay una protección automática a nivel de esquema para esto todavía.
- **Bootstrap del primer `ADMIN_RRHH`**: no existe ningún usuario admin sembrado (correctamente, para no incluir credenciales/emails reales en migraciones). El primer admin debe asignarse manualmente vía Supabase Studio/Admin API tras el primer signup — es un paso operacional, documentado aquí, no automatizado.
- **`audit_log` no se pobla automáticamente todavía**: la tabla y sus permisos están listos, pero ninguna acción (aprobar horas extra, cerrar un período, etc.) escribe en ella automáticamente — eso es responsabilidad de la capa de aplicación en una fase futura (Route Handlers), Fase 3 solo aseguró que, cuando se implemente, no pueda escribirse con un actor forjado ni editarse después.
- **MFA**: no implementado, documentado como mejora futura para `ADMIN_RRHH` si se requiere (sección 51 del encargo).
- **Rate limiting de login**: se depende de las capacidades propias de Supabase Auth; no se agregó infraestructura adicional (sección 50).

## 22. Out of scope (confirmado, no implementado en esta fase)

UI/dashboard operacional, `WorkeraClient` real y sincronización automática, generación real de Excel, Supabase Storage real (uploads/signed URLs), notificaciones/emails, motor definitivo de cálculo HH50/HH100/overtime de Instalación, y cualquier regla de negocio no confirmada (viernes de Producción, fin de semana de Instalación, bono de Instalación, regla de "R").

---

## Verificación técnica

**Tests:**
```
tests anteriores (Fase 2A+2B): 67/67
tests nuevos (Fase 3):         52/52
TOTAL:                         119/119
```

**Calidad:**
```
supabase db reset:  PASS (24 migraciones, 2A+2B+3, desde cero)
pgTAP:               PASS (119/119)
lint:                limpio
typecheck:           limpio
build:               limpio (Next.js 16, incluida migración middleware -> proxy)
```

**Verificación manual en navegador:** `/login` renderiza correctamente, un intento de login con credenciales inválidas muestra un mensaje genérico ("No pudimos iniciar sesión con esas credenciales") sin revelar si el email existe, sin errores de consola.
