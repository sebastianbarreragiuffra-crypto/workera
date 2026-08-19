# Fase 6A — Ingesta controlada Workera → Supabase

Estado: `IMPLEMENTED` — primera fase en la que datos reales obtenidos desde Workera se persisten en Supabase. Sincronización **manual y controlada**, un día por corrida, sin cron, sin UI, sin cálculo de reglas de negocio (atrasos/horas extra/bonos), sin escritura hacia Workera. Ver sección 12 ("Lo que esta fase NO hace") al final.

## 1. Arquitectura y decisión de modelado

Pipeline:

```
GET /employee + GET /attendanceData
  -> validación Zod (unknown -> DTO validado)
  -> normalización (mapper, sin colapsar eventos)
  -> resolución de identidad de empleado (employee.code -> employees.external_workera_id)
  -> clasificación insert / version / unchanged (fingerprint determinístico)
  -> persistencia idempotente (workera_attendance_events + employees bootstrap mínimo + sync_runs)
```

**Por qué una tabla nueva (`workera_attendance_events`) y no reutilizar `attendance_records`:** se auditó `attendance_records` (Fase 2A) antes de diseñar cualquier migración nueva. Representa un **resumen diario** — un único par `(actual_clock_in, actual_clock_out)` por `(employee_id, work_date)`, reforzado por el índice único parcial `attendance_records_current_key`. Workera entrega **eventos individuales** de marcación (Entrada, Salida, Inicio/Término de descanso, Entrada/Salida extraordinaria), potencialmente varios por trabajador y día. Forzarlos dentro de `attendance_records` exigiría colapsarlos en un solo clock_in/clock_out — exactamente lo que el encargo de esta fase prohíbe (ese cálculo pertenece a una fase futura de reglas de negocio). `attendance_records` no se modifica ni se reutiliza.

**Qué SÍ se reutiliza tal cual, sin crear columnas/tablas nuevas:**
- `employees.external_workera_id` (ya existente desde Fase 2A, `unique`, `not null`) como estrategia completa de identidad externa.
- `sync_runs` (Fase 2A) para metadata de cada corrida — solo se le agregó una columna aditiva (`records_unchanged`, ver sección 6).

## 2. Identidad de empleado — sin heurísticas de nombre/RUT

La resolución es **exclusivamente** `employee.code` (Workera) ↔ `employees.external_workera_id` (Supabase). Nunca se usa nombre, apellido ni RUT para inferir una coincidencia.

Validado con una llamada real de solo lectura antes de diseñar el esquema: **37/37 eventos con `employee.code` presente, 36 códigos distintos** (la única "duplicación" es un mismo trabajador con 2 eventos el mismo día — comportamiento esperado, no un problema de identidad). **0 duplicados de identidad, 0 códigos ambiguos.**

Un evento cuyo `employee.code` está vacío o ausente (incluyendo solo espacios en blanco) **bloquea toda la corrida** antes de escribir nada — no hay ninguna vía parcial (`BLOCKED_UNRESOLVED_EMPLOYEES`, cero escrituras, aunque el resto de los eventos sí tuvieran identidad resuelta).

Un `employee.code` que no existe todavía en `employees` dispara un **bootstrap mínimo**: se crea una fila nueva con `external_workera_id`, `first_name`/`last_name` (tomados de Workera, con placeholder `"(sin nombre Workera)"` si faltan) y `display_name` derivado. Un empleado ya existente **nunca se sobrescribe** — este pipeline no hace overwrite ciego de datos administrados manualmente en Supabase.

**Corrección (Pre-Fase-8):** la afirmación original de esta sección — "`GET /employee` requiere `branchOffice`+`department` para devolver resultados" — era incorrecta. Investigación real en Pre-Fase-8 confirmó que `GET /employee` sin ningún parámetro devuelve el roster completo de la compañía, paginado (97 empleados reales, 10 páginas). El hallazgo original probablemente vino de probar con los nombres visibles (`"Matriz"`, `"DEPARTAMENTO DE PRODUCCION"`) en vez de los códigos internos (`"MATRIZ"`, `"PRODUCCION"`) — los nombres visibles sí devuelven 0 resultados, lo cual se confundió con "los parámetros son obligatorios". Ver `docs/EMPLOYEE_RECONCILIATION_PRE_PHASE8.md` para el detalle y para el nuevo `getEmployeeRoster()`/`getAllEmployeeRoster()` que sí lista el roster completo — el bootstrap de esta fase (basado solo en eventos de asistencia) sigue vigente sin cambios, pero ya no es la única vía para poblar `employees`.

## 3. Modelo del evento crudo — nunca colapsado

`workera_attendance_events` persiste el evento **a nivel individual**, con el mismo patrón hecho-inmutable-versionado usado desde Fase 2A (`attendance_records`, `overtime_records`, etc.): inmutable tras insertar salvo `is_current`.

Campos clave: `employee_id` (FK resuelta, nunca un código suelto), `external_employee_code` (copia auditable del código al momento de la ingesta), `attendance_type_code`/`attendance_type_label`, `attendance_status`/`external_attendance_status`, `origin`/`origin_code`/`device_name`/`checksum`.

**Minimización de datos** (deliberada, PASO 31 del encargo): no se persiste `address`, `coordinatesMobile` ni `precision` — solo lo necesario para trazabilidad de marcación.

## 4. Timestamp crudo — conservación total

`attendance_timestamp_raw` (`text`) preserva el string exacto entregado por Workera, **sin modificar, pase lo que pase con la interpretación de zona horaria**. Es la única fuente de verdad. `work_date` se deriva de los primeros 10 caracteres del string (sin aritmética de zona horaria — es la misma fecha calendario que Workera ya reporta).

## 5. Decisión de timezone — evidencia real, nunca offset hardcodeado

Investigado como P0 antes de cualquier interpretación de hora:

- `GET /timezone` (manual oficial) devuelve, entre otras, `{id:25, name:"(UTC-04:00) Santiago", zoneDiff:-4}`.
- `attendance_timestamp_interpreted` se calcula vía trigger `BEFORE INSERT` usando `(attendance_timestamp_raw::timestamp) AT TIME ZONE 'America/Santiago'` — **nunca** un offset fijo `-3`/`-4` en código. `AT TIME ZONE 'America/Santiago'` usa el tzdata de Postgres y respeta DST automáticamente.
- Verificado empíricamente en la base real: un timestamp de agosto (invierno chileno) convierte correctamente a UTC-4 (`2026-08-18T08:01:00` local → `2026-08-18 12:01:00` UTC), consistente con `zoneDiff:-4` del manual.
- Columna **nullable**, documentada como interpretación best-effort, no como dato autoritativo.

## 6. Idempotencia — garantizada a nivel de base de datos

Fingerprint determinística, columna `GENERATED ALWAYS ... STORED` (IMMUTABLE, nunca confiada del cliente TypeScript):

```
external_fingerprint = WORKERA|{employee.code}|{attendanceTimestampRaw crudo}|{attendanceType}|{originCode ?? ''}
```

Confirmada con evidencia real: 37/37 eventos de la primera validación produjeron 37 fingerprints distintos, 0 colisiones.

**`checksum` investigado y descartado** como componente único: el manual lo documenta como *"Código Hash asociado al DISPOSITIVO"* (no al evento). Aunque la muestra real mostró 37 checksums distintos para 37 eventos de un mismo dispositivo, es evidencia insuficiente (una sola sesión, un solo dispositivo) para tratarlo como identificador único global y estable — no se usa como base de la fingerprint.

**Backstop real, no solo aplicación**: `unique index workera_attendance_events_fingerprint_current_key on (external_fingerprint) where is_current` — a lo sumo una fila vigente por fingerprint, garantizado por Postgres incluso si hubiera un bug en la capa de aplicación. La capa de aplicación (`syncWorkeraAttendance`) hace además un `SELECT` previo para clasificar cada evento en `insert`/`version`/`unchanged`, pero esa clasificación es una optimización — el índice único es la garantía real.

`sync_runs` reutiliza `records_read`/`records_created`/`records_updated`/`records_conflicted`; se agregó **una sola columna aditiva**, `records_unchanged` (no existía un contador para "idéntico al vigente, sin escritura").

## 7. Versionado no destructivo

Un evento reportado por Workera como `MODIFICADO` (o `INACTIVO`) **nunca sobrescribe** la fila anterior: la fila anterior pasa a `is_current = false` (historial preservado) y se inserta una fila nueva con `source_version + 1`. Verificado con pgTAP (`supabase/tests/025_workera_attendance_events_ingestion.sql`).

### Defecto real encontrado y corregido durante esta fase

Al ejecutar el flujo completo de versionado por primera vez, un `UPDATE` que solo tocaba `is_current` fue rechazado por el trigger genérico `enforce_immutable_columns` con `"Column external_fingerprint is immutable"` — **pese a que ningún dato de origen había cambiado**. Causa raíz: `external_fingerprint` es una columna `GENERATED ALWAYS ... STORED`, y Postgres **no calcula su valor nuevo hasta después de que corren los triggers `BEFORE ROW`** — dentro del trigger, `NEW.external_fingerprint` no es observable de forma confiable, así que la comparación genérica OLD/NEW producía un falso positivo en cualquier `UPDATE`, no solo en uno que cambiara datos reales.

Corrección: se agregó `external_fingerprint` a la lista de columnas "mutables" del trigger (`enforce_immutable_columns('is_current', 'external_fingerprint')`). Esto **no debilita la inmutabilidad real** — todas las columnas de las que depende la fingerprint (`external_employee_code`, `attendance_timestamp_raw`, `attendance_type_code`, `origin_code`) siguen protegidas individualmente por el mismo trigger, así que su valor lógico nunca puede divergir entre versiones de una fila; solo se excluye del chequeo genérico una columna cuyo nuevo valor el motor no expone en ese punto del ciclo de vida del trigger. Documentado en el comentario de la migración con referencia a la documentación oficial de Postgres sobre columnas generadas.

## 8. Paginación real

`HttpWorkeraClient.getAllAttendanceEvents` recorre **todas** las páginas — no se detiene en `page=1`. Protecciones: límite de seguridad `maxPages` (default 50, evita loop infinito ante un servidor que nunca reporta `totalPages` correctamente) y verificación de que el servidor devuelve exactamente la página solicitada (protección contra desincronización). Confirmado contra el dataset real: 2 páginas, 20 + N resultados.

## 9. `dryRun` — cero escrituras de negocio

`syncWorkeraAttendance({ dryRun: true })` ejecuta el fetch completo, la resolución de identidad y la clasificación insert/version/unchanged, pero **no escribe nada** — ni `employees`, ni `workera_attendance_events`, ni `sync_runs`. Usado como gate obligatorio antes de cualquier escritura real (ver sección 11).

## 10. Ciclo de vida de `sync_runs`

Cada corrida real (no `dryRun`) crea una fila `RUNNING` antes de escribir eventos, y la actualiza a `SUCCEEDED` (con conteos) o `FAILED` (con `error_summary` jsonb) al terminar — **nunca queda `SUCCEEDED` parcial** ante un fallo a mitad de la persistencia (ver riesgo residual, sección 13).

## 11. Gates de escritura — ejecutados en orden, con evidencia real

1. Autenticación Workera: `PASS` (respuestas HTTP 200 reales).
2. Paginación: `PASS` (2/2 páginas recorridas correctamente).
3. Validación Zod: `PASS` (100% de eventos validados contra el schema real).
4. Estrategia de timezone: segura (DST vía tzdata de Postgres, nunca offset fijo).
5. Identidad de empleado: confirmada, 0 no resueltos.
6. Restricción de idempotencia a nivel de BD: existe (índice único parcial verificado).
7. RLS/inmutabilidad del origen: `PASS` (ver sección 12, pgTAP 025).
8. Dry-run: `PASS`.
9. Suite de tests: `PASS` (pgTAP 277/277, TypeScript 79+13+26+4 = 122/122).

Con todos los gates en verde: **una** sincronización manual real para **un** día, seguida inmediatamente por una **segunda** corrida idéntica para probar idempotencia.

Resultado de la ejecución real (fecha de la validación, América/Santiago):

| Corrida | eventsFetched | employeesBootstrapped | inserted | versioned | unchanged |
|---|---|---|---|---|---|
| 1ª (real) | 33 | 33 | 33 | 0 | 0 |
| 2ª (idempotencia) | 33 | 0 | **0** | 0 | **33** |

**0 duplicados nuevos en la segunda corrida** — idempotencia confirmada a nivel de dato real, no solo de test.

## 12. Inmutabilidad del origen — verificada contra los 4 roles reales

Ni `SUPER_ADMIN`, ni `ADMIN_RRHH`, ni `SUPERVISOR_PRODUCTION`, ni `SUPERVISOR_INSTALLATION` pueden modificar una marcación cruda de Workera — mismo criterio que `attendance_records` desde Fase 2A/3. La única vía de escritura es `service_role` (el pipeline de sync, server-only), y **ni siquiera `service_role` puede modificar una columna distinta de `is_current`** (el trigger de inmutabilidad no distingue por rol). Ningún rol, incluyendo `service_role`, tiene privilegio `DELETE` — no existe borrado físico posible.

Verificado con pgTAP real (`supabase/tests/025_workera_attendance_events_ingestion.sql`, 26/26 tests, incluyendo un `UPDATE`/`DELETE` explícito intentado con cada uno de los 4 roles).

## 13. Riesgos residuales documentados (no corregidos en esta fase, por disciplina de alcance)

- **`service_role` sin GRANT de tabla en ~36 tablas del esquema**: se descubrió durante el primer dry-run real (`permission denied for table employees`) que `service_role` tiene `BYPASSRLS` pero, desde Fase 2A, ninguna migración le otorgó privilegios `GRANT` de tabla — `BYPASSRLS` omite la evaluación de políticas RLS, pero el chequeo de privilegio de tabla de Postgres sigue aplicando igual. Se corrigió el alcance mínimo que este pipeline necesita (`employees`, `sync_runs`, `workera_attendance_events`); el mismo vacío existe en el resto del esquema y queda fuera de alcance de Fase 6A.
- **Sin transacción multi-tabla real**: `supabase-js` sobre PostgREST no ofrece una transacción real entre `sync_runs`/`employees`/`workera_attendance_events` desde el cliente. La protección efectiva ante un fallo a mitad de camino no es atomicidad instantánea, sino que **cada escritura es en sí misma idempotente** — reintentar la misma corrida nunca duplica nada, gracias al índice único de fingerprint vigente y al matching por `external_workera_id`.
- **Bootstrap de empleado usa placeholders si Workera no reporta nombre/apellido** (`"(sin nombre Workera)"`) — aceptable para esta fase (identidad se basa en `external_workera_id`, no en el nombre), pero un futuro flujo de gestión de empleados debería permitir completarlo manualmente.

## 14. Procedimiento de sincronización manual

```ts
import { syncWorkeraAttendance } from "@/lib/sync/workera-attendance-sync";

// dry-run obligatorio primero
await syncWorkeraAttendance({ startDate: "2026-08-18", endDate: "2026-08-18", dryRun: true });

// real, solo si el dry-run y los gates de la sección 11 están en verde
await syncWorkeraAttendance({ startDate: "2026-08-18", endDate: "2026-08-18" });
```

Rango máximo por corrida: **1 día** (`MAX_DAYS_PER_SYNC = 1`) — un rango mayor devuelve `BLOCKED_RANGE_TOO_LARGE` sin llamar a Workera. No hay backfill histórico masivo en esta fase.

## 15. Lo que esta fase NO hace

- Sincronización automática / cron (de ningún tipo).
- UI, dashboard, ni layout.
- Cálculo de atrasos, horas extra, ni bonos.
- Generación de Excel.
- Escritura hacia Workera (`POST`/`PUT`/`DELETE` = 0, incluso para `SUPER_ADMIN`).
- Sincronización de ausencias/vacaciones/permisos.
- Backfill histórico de más de 1 día por corrida.
