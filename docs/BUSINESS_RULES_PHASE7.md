# Fase 7 — Motor de reglas de asistencia

Estado: `IMPLEMENTED`. Construye la interpretación empresarial ENCIMA de los eventos ya sincronizados (Fase 6A/6B) — nunca modifica `workera_attendance_events` ni rediseña el pipeline de sync. No incluye layout (Fase 8) ni generación de Excel.

## 1. Arquitectura

```
workera_attendance_events (Fase 6A/6B, inmutable, SOURCE OF TRUTH)
        │
        ▼  deriveDailyAttendanceRecord (src/lib/business-rules/daily-attendance.ts)
attendance_records (Fase 2A, reutilizada -- resumen diario derivado)
        │
        ▼  resolveEffectiveSchedule (schedule.ts) + generadores de candidato
late_arrival_records / early_departure_records / overtime_records (candidatos)
        │
        ▼  decisiones del supervisor (late_arrival_decisions / early_departure_decisions / overtime_decisions)
        │
        ▼  getDailyReview (daily-review.ts)
work queue por supervisor -- REQUIRES REVIEW vs NO ISSUES
```

**Decisión central**: nada poblaba `attendance_records` desde datos reales desde Fase 6A/6B (confirmado por auditoría) — `late_arrival_records`/`overtime_records`/`early_departure_records` ya dependían de su FK. En vez de rediseñar esas tablas para apuntar a `workera_attendance_events`, se construyó un derivador (`deriveDailyAttendanceRecord`) que calcula `actual_clock_in`/`actual_clock_out` (primer evento ENTRADA, último SALIDA) desde los eventos crudos vigentes y hace upsert versionado en `attendance_records`, reutilizando **todo** el motor de atrasos/overtime/bono ya construido (Fase 2A/3/Gate D) sin tocarlo.

**Fuente inmutable**: `workera_attendance_events` nunca se escribe desde este código. **Determinismo**: mismos eventos + mismo horario + misma política → mismo resultado (funciones puras para horario/atraso/salida/cumpleaños; los servicios con I/O son wrappers delgados sobre ellas).

## 2. Resolución de horario efectivo

`resolveEffectiveSchedule(supabase, employeeId, date)` — único punto de verdad, reutilizado por atrasos, salida anticipada y overtime.

Precedencia real (no existe una tabla de "horario de grupo" separada — `schedule_assignments` es siempre por-empleado; el horario "general" es simplemente el mismo `work_schedule_id` asignado a muchos trabajadores vía esa misma tabla):

1. `employee_time_control_policies` vigente con `policy_code=EXEMPT_FROM_TIME_CONTROL` → `{kind: "EXEMPT"}`, corta la cadena inmediatamente.
2. `schedule_assignments` vigente para ese empleado/fecha → resuelve `work_schedule_id`.
3. `work_schedule_rules` para ese `work_schedule_id` + día de la semana → `scheduledStart`/`scheduledEnd`, o `{kind: "DAY_OFF"}` si ambos son NULL.
4. Sin `schedule_assignment` vigente → `{kind: "NO_SCHEDULE_ASSIGNED"}` (nunca se asume el horario general — un gap real se reporta, no se adivina).

Una excepción de un solo día es modelable como un `schedule_assignment` de 1 día (`effective_from = effective_to`) — no requiere tabla nueva.

## 3. Horario general

Lunes-jueves 07:30–17:00, viernes 07:30–14:50 (ya seedeado desde Fase 2, "Horario estándar planta"). Sin cambios en esta fase.

## 4/5. Horarios individuales — Alejandro Valencia y María Vera

Resueltos por `employee_id` real (sync real de Workera ejecutado en esta fase), nunca por nombre en el motor — el motor solo lee `schedule_assignments`/`work_schedule_rules`, igual que cualquier otro trabajador.

| Trabajador | Lunes-jueves | Viernes |
|---|---|---|
| Alejandro Valencia | 08:30–18:00 | 08:30–15:50 |
| María Vera | 08:00–17:30 | 08:00–15:20 |

Creados vía `src/lib/business-rules/seed-known-schedules.ts` — seed administrativo **único**, corre bajo `service_role`, resuelve el nombre exacto (normalizado, nunca fuzzy) a un `employee_id` real. Verificado end-to-end contra datos reales sincronizados: ambos resolvieron a exactamente 1 coincidencia y sus horarios individuales quedaron correctamente asignados y resueltos por `resolveEffectiveSchedule`.

## 6. Exentos de control horario — Claudio Andrés Barrera y Michel Mendy

**No resueltos** — ver sección 14 (bloqueo parcial honesto).

Mecanismo (ya implementado y probado, listo para cuando se puedan resolver): `employee_time_control_policies.policy_code = 'EXEMPT_FROM_TIME_CONTROL'`, con `legal_basis` distinguiendo el motivo (`NO_MARKING_REQUIRED` para Claudio, `ARTICLE_22` para Michel) sin bifurcar el motor en dos mecanismos — ambos producen el mismo efecto operacional (cero atraso/salida anticipada/overtime/tarjeta-no-marcada automáticos).

## 7. Separación por área

`can_manage_employee()` (Fase 3/5D, sin cambios) ya scopea PRODUCTION/INSTALLATION por rol; ADMINISTRATION queda reservada a `is_privileged_admin()`. Las tablas nuevas de Fase 7 (`early_departure_decisions`, etc.) reutilizan exactamente ese mismo patrón: SELECT amplio (`is_corporate_user()`, criterio ya establecido desde Fase 3), INSERT de decisión scoped por `can_manage_employee()`, override de decisión ya tomada restringido a `is_privileged_admin()`.

**Aplicado a nivel de servicio, no solo RLS/UI**: `getDailyReview(supabase, callerRole, groupCode, date)` valida explícitamente que un `SUPERVISOR_PRODUCTION` nunca pueda pedir `INSTALLATION` (y viceversa) — lanza `DailyReviewAuthorizationError` antes de tocar la base de datos. Probado con pgTAP (INSERT cruzado de área denegado) y con tests TypeScript (el servicio deniega antes de consultar).

## 8. Atraso

`generateLateArrivalCandidate` — fórmula confirmada: `detected_minutes = MAX(0, (clock_in − scheduled_start) − tolerance_minutes)`, comparando en hora de PARED de `America/Santiago` (ver sección 15, bug real encontrado y corregido). Reutiliza `late_arrival_records`/`late_arrival_policies` (Fase 2A/3) tal cual.

**Acumulado semanal**: sin tabla nueva — `late_arrival_daily_totals` (vista ya existente, Fase 2B) más `SUM(...) GROUP BY` es suficiente; evita una segunda fuente de verdad.

## 9. Salida anticipada

`generateEarlyDepartureCandidate` — nueva pareja `early_departure_records`/`early_departure_decisions` (nada existía antes, confirmado por auditoría). Fórmula: `detected_minutes = MAX(0, scheduled_end − clock_out)`, usando SIEMPRE el horario efectivo (nunca 17:00 fijo) — verificado con los 6 casos exactos del encargo (general/Alejandro/María × jueves/viernes).

## 10. Flujo médico (Producción)

`reason_category='MEDICAL'` exige `document_required=true` (enforced por trigger `validate_early_departure_decision()`). El comprobante se adjunta al **`early_departure_record`** (no a la decisión puntual — mismo patrón que `absence_record_id` en `supporting_documents`, evita el problema de necesitar el documento antes de poder crear la decisión que lo referencia). **No se puede cerrar `DO_NOT_DEDUCT` sin un `supporting_documents` ya adjunto** — probado con pgTAP real (INSERT rechazado sin documento, aceptado con documento).

Plazo: 3 días hábiles desde la fecha de la decisión, vía `addBusinessDays()` (lunes-viernes, **sin calendario de feriados legales chilenos** — limitación documentada explícitamente, sección 18/74 del encargo. La tabla `holidays` ya existe desde Gate D; conectarla queda para una fase futura). Verificado: viernes + 3 días hábiles = miércoles.

Responsable: `SUPERVISOR_PRODUCTION` para trabajadores PRODUCTION (vía `can_manage_employee`); RRHH/SUPER_ADMIN pueden administrar; `SUPERVISOR_INSTALLATION` no puede resolver casos médicos de Producción (probado con pgTAP: INSERT cruzado denegado).

## 11. Licencias

Reutiliza `absence_records`/`absence_decisions` (Fase 2A) tal cual. Extensión aditiva: `decision_status` gana el valor `PENDING_DOCUMENT` (representa `LICENSE_REPORTED → PENDING_DOCUMENT`); `document_required`/`document_deadline` nuevos. **`CONFIRMED` con `document_required=true` exige un `supporting_documents` ya adjunto a `absence_record_id`** (trigger `validate_absence_decision_document()`, probado con pgTAP real). `DOCUMENT_RECEIVED → CONFIRMED` es una nueva fila versionada, nunca una mutación de la fila `PENDING_DOCUMENT`.

## 12. Cumpleaños

Tabla `employee_birthdays` (`employee_id`, `birth_month`, `birth_day` — **sin año de nacimiento**, minimización de datos explícita). `isBirthdayWeekdayAuthorizationApplicable` + `isAfterBirthdayAuthorizationThreshold` (puras): si el cumpleaños cae lunes-viernes, autorización desde las **12:00** (`AUTHORIZED_BIRTHDAY_EARLY_DEPARTURE`, `deduction=0`, `reason_category='BIRTHDAY_AUTHORIZED'` con `payroll_effect` forzado a `DO_NOT_DEDUCT` por trigger). Antes de las 12:00 sigue siendo candidata normal. Si cae sábado/domingo, la regla **no se traslada** a viernes/lunes — decisión explícita de negocio, no inventada. Verificado con los casos exactos del encargo (11:59/12:00/12:01, sábado, domingo).

### Import real desde el Excel de RRHH

`src/lib/business-rules/import-birthdays.ts` — estructura confirmada por inspección real: hoja única, encabezado en fila 4 (`Nº`/`APELLIDOS`/`NOMBRES`/`R.U.T.`/`FECHA DE NACIMIENTO`/`MES`), datos desde fila 5. Solo se leen `APELLIDOS`/`NOMBRES`/`FECHA DE NACIMIENTO` — **R.U.T. y año de nacimiento nunca se leen ni se almacenan**.

Matching **exacto** (normalizado: trim + espacios colapsados + mayúsculas) contra `employees` reales — nunca fuzzy/parcial. Dry-run ejecutado primero (solo conteos, nunca nombres impresos): **44 filas válidas, 1 con fecha faltante**; del match: **27 resueltas sin ambigüedad → importadas**, **17 sin ningún match (0 coincidencias) → `UNRESOLVED_BIRTHDAY_EMPLOYEE`, no importadas** (probablemente personal que no generó marcaciones en los días sincronizados, o ya no activo). Import real ejecutado únicamente para las 27 filas seguras.

**Advertencia de seguridad**: la librería `xlsx` (SheetJS) tiene vulnerabilidades conocidas sin parche en npm (prototype pollution `GHSA-4r6h-8v6p-xvw6`, ReDoS `GHSA-5pgg-2g8v-p4x9`). Aceptable aquí porque `import-birthdays.ts` solo procesa un archivo **local** controlado por un administrador, ejecutado manualmente, **nunca** importado por ninguna ruta HTTP/UI ni expuesto a input de red no confiable.

## 13. Overtime

`generateOvertimeCandidate` reutiliza el motor de aprobación/cap ya construido en Gate D (`overtime_records`/`overtime_policies`/clasificación HH50-HH100/selector binario Producción) — Fase 7 solo agrega la generación del **candidato** (`candidate_minutes`), que antes no existía automáticamente.

- **PRODUCTION**: política confirmada, genera candidato automático usando el horario efectivo del trabajador (individual o general) — verificado que Alejandro/María acumulan overtime desde SU propio `scheduled_end`, no 17:00 fijo.
- **INSTALLATION**: reglas exactas de overtime **siguen pendientes** (explícito en el encargo) → `OVERTIME_POLICY_REQUIRES_CONFIRMATION`, nunca genera un candidato automático, aunque `overtime_policies.overtime_eligible=true` ya exista en la tabla como placeholder.
- **ADMINISTRATION**: `overtime_eligible=false` ya confirmado → `NOT_ELIGIBLE`.

## 14. Bono de producción

Sin cambios — el motor de `bonus_policies`/`employee_daily_bonuses` (120 min aprobados → $1.000 CLP, PRODUCTION+INSTALLATION, idempotente vía `unique(overtime_decision_id)` + `unique(employee_id, work_date, bonus_policy_id)` + `pg_advisory_xact_lock`) ya estaba completamente implementado desde Gate D y no requería cambios — Fase 7 solo asegura que ahora SÍ llega un `candidate_minutes` real al pipeline de decisión que dispara ese motor.

## 15. Bug real encontrado y corregido: conversión de zona horaria

Los primeros motores de atraso/salida anticipada/overtime comparaban minutos leyendo `instant.getUTCHours()` directamente sobre el `timestamptz` de la marcación — esto da la hora **UTC**, no la hora de **pared de Santiago**, y producía resultados desfasados exactamente por el offset (-4h en invierno). Corregido con `santiagoWallClockMinutesSinceMidnight()` (`src/lib/business-rules/wall-clock.ts`), vía `Intl.DateTimeFormat` (mismo patrón DST-safe ya establecido en `src/lib/sync/target-date.ts`). Detectado por los tests exactos del encargo (07:31→1 minuto, etc.) — sin esos casos de prueba minuto-a-minuto, el bug habría pasado inadvertido.

## 16. Cambio de fuente (source-change)

Sin migración nueva — es una propiedad que ya se cae del diseño versionado existente: cada re-derivación de `attendance_records` produce una fila NUEVA (`is_current` flip); las decisiones (`late_arrival_decisions`/`early_departure_decisions`) están atadas al ID de la fila candidato ANTERIOR, así que una decisión humana ya tomada nunca desaparece ni se sobreescribe. Un candidato nuevo tras un cambio de fuente naturalmente no tiene decisión vigente todavía — `getDailyReview` lo detecta como `REQUIRES_REVIEW` sin necesitar un estado `SOURCE_CHANGED` explícito.

## 17. Work queue por supervisor

`getDailyReview(supabase, callerRole, groupCode, date)` — categorías: `LATE`, `EARLY_DEPARTURE`, `MISSING_PUNCH` (reutiliza `attendance_missing_punch_flags`, Gate D), `ABSENCE`, `OVERTIME_CANDIDATE`, `LICENSE_DOCUMENT_REQUIRED`, `MEDICAL_DOCUMENT_REQUIRED`. Partición `requiresReview`/`noIssues` sobre todos los empleados activos del área. Sin UI (Fase 8).

## 18. Auditabilidad

Todas las tablas nuevas siguen el patrón ya establecido: inmutables tras insertar salvo `is_current` (`enforce_immutable_columns`), `decided_by`/`decided_at` obligatorios en decisiones, RLS+GRANT explícitos (sin `ALTER DEFAULT PRIVILEGES`, mismo criterio desde Fase 3). Verificado con pgTAP real.

## 19. Extensión de GRANTs a `service_role`

Mismo hallazgo real de Fase 6A (`service_role` tiene `BYPASSRLS` pero cero GRANT de tabla por defecto): los motores de Fase 7 corren server-only bajo `service_role` (igual que el pipeline de sync) — se otorgó explícitamente solo lo necesario (`employee_groups`, `employee_time_control_policies`, `schedule_assignments`, `work_schedules`, `work_schedule_rules`, `late_arrival_policies`, `overtime_policies`, `overtime_types`, `attendance_records`, `late_arrival_records`, `overtime_records`). El mismo vacío sigue existiendo en el resto del esquema (documentado desde Fase 6A, fuera de alcance corregirlo integralmente aquí).

## 20. Reglas de negocio NO resueltas (explícitamente pendientes)

- Reglas exactas de overtime para INSTALLATION.
- Reglas de fin de semana para INSTALLATION.
- Tratamiento exacto HH50/HH100 de viernes (más allá de lo ya confirmado en Gate D).
- Comportamiento automático exacto de `R` (Recuperan horas) — código mantenido pero desactivado (`active=false`) desde Gate D, no se genera automáticamente.
- Overtime/bono aplicable a horarios individuales/custom más allá de PRODUCTION (INSTALLATION queda en `OVERTIME_POLICY_REQUIRES_CONFIRMATION` sin excepción).
- Calendario de feriados legales chilenos para el cálculo de 3 días hábiles (usa solo lunes-viernes).
- Horario de cron de producción (heredado de Fase 6B, sigue sin confirmar por el negocio).

## 21. Seguridad y privacidad

- Sin RUT, sin año de nacimiento, sin diagnóstico médico en ninguna tabla nueva.
- El Excel de cumpleaños nunca se commiteó al repositorio; ningún nombre/RUT real se imprimió en consola durante el import (solo conteos y números de fila).
- Fixtures de test 100% ficticias (RUTs `11.111.111-1`/`22.222.222-2` son placeholders sintéticos, nunca datos reales) — las etiquetas `"alejandro-id"`/`"maria-id"` en tests son identificadores de mock, no UUIDs reales de empleados.
- `storage_path`/documentos: reutiliza `supporting_documents` (Fase 2B) tal cual — sin binarios en Postgres, storage real pendiente (`PRIVATE_STORAGE_PENDING`, ya documentado desde Fase 2B).

## 22. Empleados no resueltos — bloqueo parcial honesto

**Claudio Andrés Barrera y Michel Mendy no se pudieron resolver a un `employee_id` real en esta fase.** Búsqueda exacta (por nombre normalizado) contra 39 empleados reales sincronizados a lo largo de 6 días distintos (14–19 de agosto de 2026) — **cero coincidencias para ambos**, en cualquier día.

Causa raíz: ambos están (por diseño, ese es justamente el punto de su excepción) exentos de marcación — nunca generan eventos en `attendanceData`, y la identidad de empleado en este proyecto se resuelve **exclusivamente** a partir de `employee.code` embebido en los eventos de asistencia (decisión confirmada en Fase 6A: no existe una llamada separada `GET /employee` en el pipeline). Sin eventos, no hay forma de que su código aparezca.

**No se creó un empleado ficticio ni se adivinó por similitud de nombre** (instrucción explícita del encargo). El mecanismo de exención (`employee_time_control_policies`) está completo, probado y listo — falta únicamente resolver sus dos `employee_id` reales, lo cual requiere una vía de identidad independiente de `attendanceData` (ej. una futura integración con `GET /employee` de Workera, o un RUT/código provisto directamente por RRHH) — expresamente fuera de alcance de lo que el pipeline actual puede hacer sin inventar datos.
