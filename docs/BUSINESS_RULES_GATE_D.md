# Reglas de negocio — Gate D (horas extra, bono, feriados, código R)

Estado histórico: `SUPERSEDED` por las reglas finales de pre-nómina 2026 y por
las migraciones `20260906130000`–`20260906210000`. Las evidencias que siguen
describen la evolución de Gate D; ante cualquier diferencia manda la matriz
vigente de esta sección y sus pruebas actuales. Dos pasadas originales:
- **Primera pasada** (migración `20260818160000_overtime_rate_holidays_bonus_engine_and_r_deactivation.sql`): clasificación HH50/HH100, feriados, límites por grupo/día, bono automático, desactivación de "R". 44 pruebas pgTAP nuevas.
- **Segundo hardening** (migración `20260818170000_production_two_hour_selector_missing_punches_and_corrections_hardening.sql`): selector binario 1h/2h exclusivo de Producción, marcaciones faltantes con red flag auditable, refuerzo de `attendance_corrections`, y 3 correcciones de defectos confirmados en la primera pasada (ver sección 8). 49 pruebas pgTAP nuevas (212/212 totales) y 4 escenarios reales de concurrencia con dos sesiones PostgreSQL (uno de ellos reveló y llevó a corregir un defecto real de concurrencia — ver sección 9).

**Advertencia obligatoria (regla 17 del encargo Gate D):** las reglas numéricas de este documento son **políticas internas confirmadas por Sebastián/Arcotex en esta conversación**, no una declaración de cumplimiento legal chileno de horas extra, feriados o remuneraciones. **Deben ser validadas por RR. HH./asesoría legal antes de producción.** Ninguna de estas reglas se presenta como estado de cumplimiento legal.

Ver también: `ARCHITECTURE.md`, `docs/DATA_MODEL_PHASE2.md`, `docs/DATA_MODEL_PHASE2B.md`, `docs/DECISIONS_PENDING.md`, `docs/THREAT_MODEL.md`.

## 1. Clasificación HH50 / HH100

- **HH50**: lunes a sábado, sin feriado.
- **HH100**: domingo, o cualquier día marcado como feriado activo. Si domingo y feriado coinciden, la tasa sigue siendo HH100 pero prevalece la regla operativa especial de domingo de Instalación (sin tope fijo); no se aplica el tope de festivo.
- Calculada server-side, de forma determinista, por `public.classify_overtime_type_id(work_date)` — el cliente no puede elegir la tasa: el trigger `overtime_records_classify_rate` sobrescribe siempre `overtime_type_id` según la fecha, ignorando cualquier valor propuesto en el INSERT/UPDATE.
- Usa `work_date` (tipo `date`, sin componente horario) — sin conversión de zona horaria involucrada en la clasificación en sí.

## 2. Calendario administrativo de feriados

Tabla nueva `public.holidays` (fecha única, nombre, activo/inactivo, auditoría). Lectura para cualquier corporativo; creación/edición solo `ADMIN_RRHH`. Desactivar (`active=false`) en vez de eliminar preserva la clasificación histórica de decisiones/bonos ya calculados sobre esa fecha — una fecha desactivada deja de tratarse como feriado únicamente hacia adelante.

## 3. Límites por grupo y día (máximo APROBABLE, no candidateado)

| Grupo | Lunes-viernes | Sábado | Domingo | Feriado (cualquier día) |
|---|---|---|---|---|
| PRODUCTION | 120 min | 120 min | Bloqueado | 360 min |
| INSTALLATION | 120 min | 120 min | Sin tope fijo; aprobación del jefe/supervisor de Instalación | 360 min; si también es domingo prevalece domingo sin tope fijo |
| ADMINISTRATION | Sin cambio — no elegible (regla previa, `overtime_policies.overtime_eligible=false`) | — | — | — |

Implementado en `public.max_approvable_overtime_minutes(employee_group_code, work_date)`, invocado desde `validate_overtime_decision()` (extensión del trigger ya existente de Fase 2A). **El exceso se rechaza explícitamente** (excepción, no aprobación recortada en silencio) — un supervisor que intenta aprobar más del máximo ve un error claro. El dato original (`overtime_records.candidate_minutes`, ej. un registro importado que exceda el máximo) **nunca se altera**: el límite se aplica solo a `approved_minutes` en el momento de la decisión.

Solo el domingo de Instalación carece de tope fijo: allí la autoridad real es que el supervisor de Instalación (`SUPERVISOR_INSTALLATION`, ya existente, sin rol nuevo) registre/confirme el número exacto de minutos aprobados vía `overtime_decisions.approved_minutes`, sujeto a `approved_minutes <= candidate_minutes`. Lunes a sábado conserva 120 minutos y los festivos no dominicales 360 minutos.

## 4. Bono diario

- Aplica a **PRODUCTION** e **INSTALLATION**, tanto para HH50 como HH100, incluidos domingos de Instalación cuando existan al menos 120 minutos aprobados.
- Umbral: **120 minutos** de horas extra **aprobadas** (no candidateadas ni marcadas) en el día.
- Monto: **$1.000 CLP fijo** por trabajador y día — nunca proporcional a las horas (verificado: 120, 121, 180 y 360 min aprobados producen exactamente $1.000, no un múltiplo).
- Nunca más de un bono por trabajador y fecha — garantizado en tres niveles independientes: `unique(overtime_decision_id)` (Fase 2B), `unique(employee_id, work_date)` (Gate D, nuevo), y lock consultivo (`pg_advisory_xact_lock`) en el motor de recomputación.
- **Automático**: antes deliberadamente no automatizado ("fase futura", Fase 2B); Gate D lo automatiza con `recompute_employee_daily_bonus()` (`SECURITY DEFINER`) disparado por un trigger `AFTER INSERT OR UPDATE` sobre `overtime_decisions`. Recomputación **completa** (no incremental) desde la decisión vigente actual — nunca aritmética sobre un valor ya derivado.
- Si una aprobación se corrige/invalida antes del cierre (bajando de 120 min), el bono ya otorgado **se retira** automáticamente (verificado con pgTAP y evidencia real de concurrencia).
- **Período cerrado**: si el `work_date` cae dentro de un `reporting_periods` con `status='CLOSED'`, cualquier intento de recomputar (crear o retirar) el bono **falla explícitamente** (excepción, no mutación silenciosa) — reabrir el período es un paso explícito y separado, ya existente (RLS de Fase 3).
- La clasificación HH50/HH100 **no** afecta el monto del bono — son reglas independientes.

## 5. Código de asistencia "R" (Recuperan horas)

- La empresa confirmó que no usa recuperación de horas.
- `attendance_statuses.active = false` para el código `R` (desactivado, no eliminado).
- Un trigger (`attendance_status_records_prevent_inactive`) bloquea **únicamente INSERT nuevos** que referencien un código inactivo — nunca se dispara en UPDATE, así que ningún registro histórico existente se toca, revalida ni elimina.
- Los 11 códigos del catálogo siguen existiendo (verificado); `R` conserva su `category='RECOVERY'` y su FK sigue resoluble para cualquier registro histórico.

## 6. Concurrencia — diseño y evidencia real

Todos los mecanismos nuevos están diseñados para ser seguros ante:
- **Múltiples registros de horas extra del mismo trabajador/día**: `overtime_records_current_per_day_key` (unique parcial, Gate D) garantiza un único candidato vigente por trabajador+día — un recálculo crea una fila nueva (`calculation_version`), nunca dos vigentes simultáneas.
- **Dos aprobaciones concurrentes sobre el mismo registro**: el índice único preexistente `overtime_decisions_current_key` (Fase 2A) serializa esto a nivel de motor de almacenamiento — verificado con evidencia real (dos sesiones concurrentes, una recibe `23505 duplicate key`, rollback limpio, sin estado parcial).
- **Recomputación concurrente del bono para el mismo trabajador+fecha**: `pg_advisory_xact_lock(hashtextextended(employee_id||':'||work_date, 0))` serializa — verificado con evidencia real vía `pg_stat_activity` (`wait_event_type=Lock, wait_event=advisory`) mostrando una sesión bloqueada mientras la otra sostenía el lock, y confirmando el resultado final: exactamente un bono, monto exacto $1.000, cero filas duplicadas.
- **Corrección concurrente con una aprobación**: el mismo lock + la recomputación completa (no incremental) garantizan que el estado final siempre refleja la decisión vigente real, nunca un intermedio.

Evidencia completa (comandos, salidas de `pg_stat_activity`, timestamps de adquisición/liberación del lock) se generó en scripts temporales fuera del repositorio, ejecutados contra el contenedor Docker local (`supabase_db_Workera`), y se eliminaron al finalizar — no forman parte del repositorio.

## 7. Minutos reales y aprobados exactos — regla vigente

El selector binario y cualquier redondeo de la segunda pasada histórica de
Gate D quedaron eliminados. La versión final conserva íntegro
`overtime_records.candidate_minutes` y registra `approved_minutes` en minutos
exactos. No se puede aprobar más que el candidato real ni más que el máximo
aprobable del día: 120 minutos de lunes a sábado, 360 en festivo no dominical y
sin tope fijo únicamente el domingo de Instalación. Producción en domingo queda
bloqueada y Administración no genera horas extra automáticamente.

Matriz vigente (candidato real = `overtime_records.candidate_minutes`):

| Minutos extra reales | Decisión competente | Resultado pagable | Bono diario |
|---|---|---|---:|
| 0 | 0 | 0 | $0 |
| 1–59 | No puede aprobarse como pagable; queda en alerta roja | 0 | $0 |
| 60–119 | 0 o cualquier cantidad exacta entre 60 y el candidato | Minutos exactos aprobados | $0 |
| 120 o más, día con tope de 120 | 0 o cualquier cantidad exacta entre 60 y 120 | Máximo 120; el candidato real no se recorta | $1.000 solo si se aprueban al menos 120 |
| Festivo no dominical | 0 o cualquier cantidad exacta entre 60 y `min(candidato, 360)` | Máximo 360; el candidato real no se recorta | $1.000 solo si se aprueban al menos 120 |
| Domingo de Instalación | 0 o cualquier cantidad exacta entre 60 y el candidato | Sin tope fijo | $1.000 solo si se aprueban al menos 120 |

`validate_overtime_decision()` aplica estos límites, exige que aprobado más
rechazado reconcilie exactamente con el candidato y conserva el motivo y el
actor. La RLS final autoriza a `ADMIN_RRHH` o al supervisor del área histórica
vigente en la fecha; `SUPER_ADMIN` conserva lectura y auditoría, pero no firma
decisiones laborales.

## 8. Marcaciones faltantes y correcciones auditadas (segundo hardening)

- **Detección**: `MISSING_CLOCK_IN` / `MISSING_CLOCK_OUT` / `MISSING_BOTH`, vía trigger automático sobre `attendance_records` (`flag_missing_attendance_punch()`) que crea una fila en la tabla nueva `attendance_missing_punch_flags`. Nunca se inventa un valor ni se trata como ausencia definitiva.
- **Ciclo de vida de la flag**: `PENDING_CONTACT` (default) → `CONTACTED` → `RESOLVED` (o `UNRESOLVED`). Solo RRHH o el jefe correspondiente (`can_manage_employee`) puede avanzarla; `contacted_by`/`resolved_by`/`*_at` se fuerzan siempre al actor real (`auth.uid()`/`now()`), nunca a un valor de cliente.
- **Bloqueo de aprobación**: `validate_overtime_decision()` consulta el dato **efectivo** (crudo + última corrección vigente, vía la vista nueva `attendance_effective_punches`) antes de permitir `approved_minutes > 0` — si sigue incompleto, rechaza con error de dominio.
- **Corrección — se reutiliza `attendance_corrections`** (Fase 3), no se creó una tabla paralela: ya satisfacía referencia al hecho inmutable, valor corregido, motivo `NOT NULL`, autor forzado a `auth.uid()`, timestamp, versionado `is_current`. Se le agregó: `corrected_by_role` (rol del autor al momento, vía `current_user_role()`, nunca de cliente), `correction_type` (ENTRADA/SALIDA/AMBAS, columna generada), `reason` no vacío (CHECK), límites de zona horaria de Chile explícitos (`corrected_clock_in` debe caer en `work_date`; `corrected_clock_out` en `work_date` o el día siguiente, turno nocturno), bloqueo en período `CLOSED`, y bloqueo si ya existe una decisión vigente con minutos aprobados > 0 sobre el mismo hecho (conflicto controlado — RRHH debe invalidar la decisión primero, lo que retira el bono automáticamente).
- **El dato crudo de Workera nunca se sobrescribe**: `attendance_records.actual_clock_in/out` permanece intacto siempre; toda consulta de negocio debe usar `attendance_effective_punches` (crudo vs. efectivo), no el crudo solo.
- **Historial preservado**: una segunda corrección sobre el mismo hecho requiere que ADMIN_RRHH invalide la vigente primero (mismo patrón que `overtime_decisions`) — ninguna corrección se borra ni se edita.

## 9. Correcciones aplicadas a la primera pasada de Gate D (segundo hardening, PASO 1)

Auditoría independiente confirmó 3 defectos reales en la migración `20260818160000` (aún no comprometida al momento de corregirse):

1. **`employee_daily_bonuses_employee_work_date_key`** era `unique(employee_id, work_date)` — demasiado amplio: el esquema de `bonus_types`/`bonus_policies` está diseñado explícitamente para soportar múltiples tipos de bono futuros el mismo día. Corregido a `unique(employee_id, work_date, bonus_policy_id)`.
2. **`max_approvable_overtime_minutes()`** re-consultaba el calendario de feriados **en vivo** al momento de la decisión, en vez de usar la clasificación HH50/HH100 ya congelada en el `overtime_record`. Si un feriado se desactivaba entre la creación del registro y la decisión, el tope aprobable podía divergir retroactivamente de la clasificación real ya almacenada. Corregido: la función ahora recibe el `overtime_type_id` ya congelado como parámetro.
3. **Carrera de decisiones concurrentes** exponía el error crudo de Postgres `23505 duplicate key value violates unique constraint "overtime_decisions_current_key"`, filtrando el nombre interno de la constraint. Corregido con un advisory lock transaccional (`pg_advisory_xact_lock`) + prevalidación que devuelve un error de dominio genérico.

## 10. Concurrencia — evidencia real (segundo hardening)

4 escenarios probados con dos sesiones PostgreSQL reales (`docker exec` contra el contenedor local, `pg_stat_activity` para observar el bloqueo mientras ocurre):

1. **Dos decisiones concurrentes sobre la misma `overtime_record`** (60 vs. 120 min): la segunda sesión queda observada en `wait_event_type=Lock, wait_event=advisory`, se desbloquea al comprometerse la primera, y recibe el error de dominio genérico (no `23505`). Estado final: una sola decisión vigente.
2. **Dos correcciones concurrentes sobre el mismo hecho**: mismo patrón — inicialmente (sin el fix de este punto) la segunda sesión exponía el `23505` crudo del índice único `attendance_corrections_current_key`; se agregó el mismo mecanismo de advisory lock + prevalidación usado para decisiones. Confirmado tras el fix: bloqueo real, error de dominio limpio, una sola corrección vigente.
3. **Corrección concurrente con una aprobación de horas extra sobre el mismo hecho** — este escenario **reveló un defecto real de concurrencia**: los dos caminos de escritura (aprobar horas extra, registrar una corrección) usaban advisory locks independientes (namespaces distintos, sin relación entre sí), permitiendo que ambas transacciones comprometieran sin que ninguna viera el cambio no confirmado de la otra (ventana TOCTOU bajo `READ COMMITTED`) — reproducido empíricamente: una decisión aprobada y una corrección registrada sobre el mismo hecho, ninguna bloqueando a la otra. **Corregido**: ambos caminos ahora adquieren el mismo namespace de advisory lock (keyed por `attendance_record_id`), serializándolos genuinamente. Un segundo intento tras el fix reveló además un **bug de orden de triggers** (dos triggers `BEFORE INSERT` separados sobre `attendance_corrections` se ejecutaban en orden alfabético, y el que comprobaba "¿existe una decisión activa?" corría *antes* de adquirir el lock) — corregido fusionando ambas comprobaciones en un único trigger, en el orden correcto (lock primero). Verificado tras ambos fixes: la corrección queda bloqueada correctamente con el error de dominio esperado cuando la decisión ya se comprometió primero.
4. **Recomputación del bono**: mecanismo sin cambios funcionales respecto a la primera pasada (ya verificado entonces con evidencia real de `pg_advisory_xact_lock` + `pg_stat_activity`); se confirmó vía pgTAP que el ajuste de la unique constraint (punto 9.1) no introduce duplicados (idempotencia verificada: una llamada repetida a `recompute_employee_daily_bonus` no crea un segundo bono).

Todos los scripts temporales de estas pruebas se eliminaron al finalizar — no forman parte del repositorio.

## 11. Límites históricos de Gate D y estado final posterior

Gate D por sí solo no incluía el motor automático, el ciclo 16–15 ni la UI.
Esos límites describen únicamente aquel hito histórico: el motor, la exportación,
la importación y el cierre 16–15 existen en la versión final 2026 y usan minutos
exactos. Siguen pendientes la propagación opcional a ficha/diseños futuros y el
aislamiento multiempresa completo de `reporting_periods`, ambos documentados en
`docs/DECISIONS_PENDING.md`. Ninguna fase valida cumplimiento legal; se mantiene
la advertencia obligatoria al inicio de este documento.
