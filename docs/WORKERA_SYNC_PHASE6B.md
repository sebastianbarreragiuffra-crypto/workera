# Fase 6B — Sincronización automática diaria Workera → Supabase

Estado: `IMPLEMENTED`, infraestructura **código-completa pero NO activada en producción**. Convierte la sincronización manual y controlada de [Fase 6A](WORKERA_SYNC_PHASE6A.md) en una automatización diaria operacionalmente segura y observable — reutilizando `syncWorkeraAttendance` sin duplicarlo. Sin reglas de negocio, sin UI, sin Excel — ver sección 14.

## 1. Arquitectura: automatización sobre el mismo pipeline

```
Vercel Cron (GET, no desplegado)          Rerun administrativo (POST)
        │                                          │
        ▼                                          ▼
   CRON_SECRET válido                    sesión SUPER_ADMIN/ADMIN_RRHH
        │                                          │
        └──────────────┬───────────────────────────┘
                        ▼
          src/lib/sync/scheduler.ts
     (target date, ventana de reconciliación,
      lock de concurrencia, reintentos clasificados)
                        │
                        ▼
        syncWorkeraAttendance()  (Fase 6A, sin modificar su pipeline)
```

`scheduler.ts` nunca reimplementa fetch/validación/identidad/persistencia — decide únicamente **cuándo** y **cuántas veces** invocar el mismo servicio de Fase 6A. Las únicas extensiones hechas a `syncWorkeraAttendance` fueron **aditivas**: `triggeredBy`/`attempt`/`retryOf` en los parámetros, `errorCategory` y el status `ALREADY_RUNNING` en el resultado — ningún test de Fase 6A se modificó y los 13 tests originales siguen pasando sin cambios.

## 2. Fecha objetivo — D-1 calendario, no "menos 24 horas"

`src/lib/sync/target-date.ts#resolveTargetDate(now, timeZone)`: resuelve el año/mes/día **calendario** en `America/Santiago` vía `Intl.DateTimeFormat` (que ya conoce las reglas DST reales de esa zona), y luego resta 1 día mediante aritmética de enteros de calendario sobre una representación UTC sintética — un dominio sin DST propio, donde restar exactamente 86 400 000 ms siempre mueve un día calendario exacto, sin importar si el día real tuvo 23, 24 o 25 horas.

`now` se inyecta siempre como parámetro (nunca `new Date()` interno) — determinista en tests, sin esperar hasta una hora real. Verificado con tests alrededor de ambas transiciones DST de Chile, cruce de fin de año y cruce de año bisiesto (`src/lib/sync/target-date.test.ts`).

## 3. Ventana de reconciliación

Workera puede reportar cambios (`MODIFICADO`/`INACTIVO`/correcciones) días después del sync original — confirmado empíricamente en Fase 6A (37 eventos en una validación, 33 en el sync real posterior, mismo día calendario). El cron no solo sincroniza D-1: también re-consulta `WORKERA_SYNC_RECONCILIATION_DAYS` días adicionales anteriores a D-1 (`resolveReconciliationWindow`).

**Default: 2 días** (ventana total de 3 días: D-3, D-2, D-1). `SYNC_SCHEDULE_PENDING_BUSINESS_CONFIRMATION` — es un valor técnico razonable, no una cifra confirmada por el negocio; configurable vía `WORKERA_SYNC_RECONCILIATION_DAYS` sin requerir un despliegue de código para ajustarlo. Nunca un backfill histórico: la ventana es siempre pequeña y anclada a "ayer y algunos días antes", nunca un rango arbitrario.

Un evento reportado `MODIFICADO`/`INACTIVO` en una reconciliación se versiona con el mismo mecanismo no destructivo de Fase 6A (`is_current=false` + fila nueva con `source_version+1`) — nunca se sobrescribe ni se borra. Un evento que existía en un sync anterior y simplemente **no aparece** en una respuesta posterior **no se borra** — solo una señal explícita de Workera (`MODIFICADO`/`INACTIVO` en el payload) puede versionar un evento; la sola ausencia nunca es tratada como "eliminado" (comportamiento ya garantizado por Fase 6A, sin cambios en Fase 6B).

## 4. Scheduler elegido: Vercel Cron

**Decisión**: Vercel Cron, sobre Supabase Cron (`pg_cron`) u otra alternativa.

**Razón**: el pipeline completo (fetch HTTP a Workera, validación Zod, resolución de identidad, persistencia vía PostgREST) ya está escrito en TypeScript/Node — exactamente lo que un Route Handler de Next.js ejecuta de forma nativa. `pg_cron` ejecuta SQL dentro de Postgres; llamar a una API HTTP externa desde ahí requeriría `pg_net` u otra capa adicional, duplicando en SQL una lógica que ya existe y está probada en TypeScript. Vercel Cron simplemente invoca una URL en un horario — server-side, sin depender del navegador, sin necesitar un servidor Windows encendido, con logs/observabilidad ya integrados al mismo proyecto Vercel donde se despliega la app.

**Mecanismo**: `vercel.json` declara `{"crons": [{"path": "/api/sync/workera", "schedule": "0 9 * * *"}]}`. Vercel invoca esa ruta con **GET** (no POST) en el horario indicado, agregando automáticamente `Authorization: Bearer $CRON_SECRET` cuando esa variable está configurada en el proyecto de Vercel.

**Horario**: `0 9 * * *` (09:00 UTC) es un default técnico razonable — en invierno chileno (UTC-4) equivale a las 05:00 Santiago, en verano (UTC-3) a las 06:00 — antes de que un supervisor típico revise el día anterior. `SYNC_SCHEDULE_PENDING_BUSINESS_CONFIRMATION`: Vercel Cron usa cron UTC plano, no cron consciente de zona horaria, así que la hora de pared en Santiago se corre ±1h entre horario de verano/invierno — no afecta la corrección del sync (`resolveTargetDate` sigue calculando D-1 correctamente sin importar exactamente cuándo corre dentro de la madrugada), solo el horario operativo exacto percibido, que debe confirmarse con el negocio antes de ajustar `vercel.json`.

## 5. Autenticación del cron — `CRON_SECRET`

`GET /api/sync/workera` exige `Authorization: Bearer <CRON_SECRET>`, comparado con `crypto.timingSafeEqual` (mitiga ataques de timing) tras verificar longitud igual. **Fail-closed**: sin `CRON_SECRET` configurado en el servidor, el camino de cron nunca se acepta, sin importar qué header llegue.

`CRON_SECRET` es un secreto **independiente** de `WORKERA_API_KEY` y de `SUPABASE_SERVICE_ROLE_KEY` — ninguno de esos dos se reutiliza como secreto de cron. Server-only, nunca `NEXT_PUBLIC_CRON_SECRET`, nunca impreso en logs, `.env.example` solo documenta la clave vacía.

`GET` **nunca** acepta una sesión de usuario como alternativa (evita que un navegador autenticado dispare el cron por accidente visitando la URL). `POST` (rerun manual) **nunca** acepta el secreto de cron como alternativa — dos caminos de autorización completamente independientes, verificados por separado.

## 6. Rerun administrativo manual

`POST /api/sync/workera` con body `{ startDate, endDate }`. Autorización vía `requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH")` (`src/lib/supabase/authorize.ts`, extraído de `src/lib/admin/user-management.ts` en esta fase para que ambos módulos reutilicen exactamente el mismo criterio de sesión real + rol, en vez de tener una segunda copia).

| Rol | Rerun manual |
|---|---|
| SUPER_ADMIN | Sí |
| ADMIN_RRHH | Sí — la recuperación operativa de asistencia es parte del flujo de RRHH |
| SUPERVISOR_PRODUCTION | No |
| SUPERVISOR_INSTALLATION | No |
| anónimo | No |

Ningún rol (incluido SUPER_ADMIN) puede cambiar la configuración del cron ni ver `CRON_SECRET`/`WORKERA_API_KEY` — esos son secretos de servidor, nunca expuestos por ningún endpoint de esta fase.

Rango acotado por `MAX_MANUAL_SYNC_DAYS = 31` — un rerun no puede convertirse accidentalmente en un backfill histórico masivo (`2018-01-01 → hoy` es rechazado explícitamente, nunca ejecutado parcialmente).

## 7. Concurrencia — índice único parcial, no una tabla de lock separada

**Decisión evaluada y descartada**: una tabla `sync_locks` dedicada con `pg_advisory_lock`/UPSERT atómico. Se descartó tras confirmar con una prueba real que `syncWorkeraAttendance` (Fase 6A) **ya inserta su propia fila `sync_runs` con `status='RUNNING'`** como parte de su flujo normal — un mutex separado sería una segunda fuente de verdad de concurrencia, con el riesgo real de desincronizarse de la primera (el lock se libera pero el `sync_run` real sigue `RUNNING`, o viceversa).

**Mecanismo elegido**: `sync_runs_no_concurrent_running_key`, un índice único parcial sobre `(target_period_start, target_period_end) WHERE status = 'RUNNING'`. Dos procesos que intentan sincronizar el mismo día compiten por la misma fila de índice — Postgres serializa esa competencia internamente (la misma garantía de atomicidad que pedía un advisory lock, sin necesitar afinidad de conexión, que de todas formas no existe sobre PostgREST/un pooler en modo transacción). El segundo `INSERT` falla con `23505`; `syncWorkeraAttendance` lo traduce a `status: "ALREADY_RUNNING"`.

**Prueba real** (`src/lib/sync/scheduler.concurrency.test.ts`, opt-in vía `SYNC_CONCURRENCY_REAL_TEST=1`, ejecutada contra Postgres local real durante esta fase): dos `INSERT` verdaderamente concurrentes (dos requests PostgREST en paralelo, no dos statements secuenciales en una transacción) para el mismo rango → exactamente uno tiene éxito, el otro recibe `23505`, y solo existe **una** fila en la base al final. **Cero duplicados confirmado con concurrencia real, no solo simulada.**

**Recuperación de locks huérfanos**: `reclaim_stale_workera_sync_runs(stale_after_seconds default 900)` marca `FAILED` (con `error_category='CONCURRENCY'`) cualquier `sync_run` `RUNNING` más viejo que el umbral — un proceso serverless caído a mitad de camino no puede bloquear un día para siempre. Se invoca al inicio de cada intento, antes de competir por el índice único. `EXECUTE` restringido a `service_role` únicamente.

## 8. Reintentos — misma política que Fase 4/5, no una segunda contradictoria

`src/lib/sync/errors.ts#classifySyncError` mapea cada excepción capturada a una categoría estable (`WORKERA_AUTH`/`WORKERA_RATE_LIMIT`/`WORKERA_TIMEOUT`/`WORKERA_NETWORK`/`WORKERA_SERVER`/`WORKERA_PAYLOAD`/`EMPLOYEE_RESOLUTION`/`DATABASE`/`CONCURRENCY`/`CONFIGURATION`), persistida en `sync_runs.error_category`.

`isRetryableSyncErrorCategory` reutiliza **exactamente** el mismo criterio ya establecido por `isRetryableWorkeraError` (Fase 4/5, `src/lib/workera/errors.ts`, existía pero no estaba conectado a ningún loop de reintento hasta esta fase): retryable = timeout de red, rate limit, error 5xx de Workera. No retryable = credenciales inválidas, payload inválido, configuración — reintentar eso nunca cambia el resultado. Verificado con un test que compara ambas funciones para cada subclase de error (`src/lib/sync/errors.test.ts`).

`MAX_SYNC_ATTEMPTS = 3` (1 intento inicial + 2 reintentos) — **nunca infinito**. Backoff corto (1s, 3s + jitter de hasta 300ms) — todo el ciclo corre dentro de una sola invocación de función serverless con límite de tiempo de plataforma; no se reintenta "una hora después" dentro de la misma request. Si el trabajo creciera demasiado en el futuro (rangos más amplios, más reconciliación), migrar a una cola de trabajos en background — fuera de alcance de esta fase.

Cada intento es una fila `sync_runs` nueva (`attempt` incremental, `retry_of` enlazando al intento anterior) — mismo patrón de hecho-inmutable-versionado que el resto del esquema desde Fase 2A, nunca una fila mutada para "reintentarla".

## 9. Recuperación ante fallo parcial de paginación

`syncWorkeraAttendance` obtiene **todas** las páginas antes de escribir cualquier dato (Fase 6A) — si la página 3 de 3 falla, la corrida entera falla `FAILED` sin haber escrito nada (ni siquiera la fila `sync_runs`, que se crea recién después del fetch completo). No hay estado parcial engañoso que sugiera que algo se sincronizó cuando no fue así.

El reintento siguiente (mismo día, gracias al mismo índice único que lo serializa) vuelve a pedir todas las páginas desde cero — la idempotencia de Fase 6A (fingerprint + índice único de evento vigente) garantiza que si una corrida anterior SÍ alcanzó a persistir parte de los datos antes de fallar en un paso posterior, el reintento no duplica nada: los eventos ya persistidos se clasifican `unchanged`, no se reinsertan.

## 10. Identidad de empleado — sin una segunda llamada `GET /employee`

Confirmado en Fase 6A y reconfirmado en esta fase: `attendanceData` ya entrega el detalle completo del empleado (`code`/`identification`/`name`/`lastName`/`branchOffice`/`department`/etc.) **embebido en cada evento** — no existe un escenario donde `employee.code` esté presente pero el resto del detalle no lo esté. Por eso el pipeline automatizado **no agrega** una llamada separada a `GET /employee`: sería una segunda fuente de identidad redundante con la que ya trae cada evento.

Un evento con `employee.code` vacío/ausente (incluyendo solo espacios) bloquea la corrida completa (`BLOCKED_UNRESOLVED_EMPLOYEES`, `errorCategory: EMPLOYEE_RESOLUTION`) — nunca se crea un empleado ficticio, nunca una corrida con empleados sin resolver termina `SUCCEEDED` silenciosamente. Sin cambios respecto a Fase 6A; la automatización hereda esta garantía sin reimplementarla.

## 11. Salud/estado del sync

`src/lib/sync/scheduler.ts#getWorkeraSyncHealth(deps, staleAfterHours=30)` — server-side, sin UI, sin notificaciones. Consulta `sync_runs` para:

- `lastSuccess` / `lastFailure` (con `errorCategory`).
- `currentlyRunning` (filas `RUNNING`).
- `status`: `RUNNING` (hay una corrida activa) > `UNKNOWN` (nunca hubo un `SUCCEEDED`) > `STALE` (el último éxito es más viejo que `staleAfterHours`, default 30h — cubre un día calendario completo de margen sobre la cadencia diaria) > `DEGRADED` (hay un `FAILED` más nuevo que el último `SUCCEEDED`) > `HEALTHY`.

## 12. Observabilidad — sin PII, sin secretos

Cada `sync_run` registra: rango, `started_at`/`finished_at`, `status`, `triggered_by`, `attempt`/`retry_of`, conteos (`records_read`/`created`/`updated`/`unchanged`/`conflicted`), `error_category`, `error_summary` (mensaje técnico corto, nunca payload/stack trace con datos de empleado). El log estructurado de Workera (`src/lib/workera/logging.ts`, sin cambios) sigue sin loguear `API_USER`/`API_KEY`/nombre/RUT — solo `correlationId`/`operation`/`statusCode`/`durationMs`/`outcome`.

La respuesta HTTP de `/api/sync/workera` (ambos métodos) nunca incluye `errorMessage` crudo ni detalles internos — solo `status`/`attempts`/conteos agregados por fecha.

## 13. Workera — GET-only, confirmado de nuevo

Cero cambios al cliente HTTP de Workera en esta fase: `HttpWorkeraClient` solo implementa `getAttendanceEvents`/`getAllAttendanceEvents` (lectura). `POST`/`PUT`/`DELETE` hacia Workera = 0 en todo el código de este proyecto, verificado por inspección — no existe ningún método de escritura implementado, ni siquiera accesible para `SUPER_ADMIN`.

## 14. Lo que esta fase NO hace

- Producción: `WORKERA_SYNC_ENABLED` no está activado (`.env.example` documenta el default como `false`); aunque `vercel.json` llegara a desplegarse, el handler no ejecuta ningún sync real hasta que esa variable sea explícitamente `"true"` — defensa en profundidad independiente de si el cron está conectado o no.
- Cron NO desplegado/conectado a un proyecto Vercel real en esta sesión.
- Reglas de negocio: atrasos, horas extra, bonos, estados de asistencia, totales semanales.
- Excel, UI, dashboard, panel de administración de sync.
- Sincronización de ausencias/vacaciones/permisos.
- Backfill histórico masivo (rerun manual acotado a `MAX_MANUAL_SYNC_DAYS`, cron acotado a D-1 + ventana de reconciliación pequeña).
- Cola de trabajos en background — el retry vive dentro de una sola invocación de función; documentado como punto de migración futuro si el volumen crece.

## 15. Configuración (Fase 6B)

| Variable | Server-only | Default | Descripción |
|---|---|---|---|
| `WORKERA_SYNC_ENABLED` | Sí | `false` | Interruptor explícito -- sin esto en `"true"`, el cron no ejecuta ningún sync real. |
| `CRON_SECRET` | Sí | (vacío) | Secreto independiente de `WORKERA_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY`. Vercel lo agrega como `Authorization: Bearer` automáticamente. |
| `WORKERA_SYNC_RECONCILIATION_DAYS` | Sí | `2` | Días adicionales antes de D-1 que el cron reconsulta. |
