# Fase 5 — Readiness de conexión real con Workera

**Estado: `PHASE_5_BLOCKED_WAITING_FOR_WORKERA_API`.** No se implementó `HttpWorkeraClient` ni se realizó ninguna conexión real. No se creó ninguna migración. No se escribió ningún dato a Supabase.

Este documento reemplaza como referencia vigente a `docs/WORKERA_API_REQUIREMENTS.md` (Fase 4) para efectos de "qué falta" — ese documento sigue siendo válido y no se elimina, este lo actualiza con el resultado de la búsqueda exhaustiva realizada en esta fase y con la matriz de capacidades formal pedida en el encargo de Fase 5.

---

## 1. Auditoría de Fase 4 (resumen — no se modificó nada)

Confirmado por inspección directa de `src/lib/workera/` y sus tests:

| Componente | Estado |
|---|---|
| `WorkeraClient` (interfaz) | Existe (`client.ts`) — `getEmployees`, `getAttendance`, `getAbsences` únicamente |
| `MockWorkeraClient` | Existe (`mock-client.ts`) — datos ficticios, 9 escenarios |
| `HttpWorkeraClient` | **No existe** — correcto para el estado actual, no se crea en esta fase (Case A) |
| Runtime validation | Zod, `schemas/*.ts`, contra la forma placeholder de `types/raw.ts` |
| Normalized DTOs | `types/normalized.ts` (`NormalizedEmployee`, `NormalizedAttendance`, `NormalizedAbsence`, etc.) |
| Mappers | `mappers/*.ts`, con tablas de mapeo inyectadas (vacías por defecto) |
| Error model | `errors.ts` — 8 errores tipados + `isRetryableWorkeraError()` |
| Timeout | `config.ts` expone `requestTimeoutMs` (default 10000ms) — sin usar todavía porque no hay cliente HTTP real |
| Retry strategy | Documentada en `errors.ts` (network/timeout/429/5xx retryable), sin implementación de ejecución porque no hay cliente HTTP real |
| Pagination abstraction | `types/common.ts` — `WorkeraPageToken` opaco, no asume page/pageSize/cursor |
| Timezone handling | `mappers/instant.ts` — conserva el valor original + intenta parseo UTC, documentado como pendiente de confirmar contra el formato real |
| Capabilities | `capabilities.ts` — todo `UNKNOWN` |
| server-only boundary | `config.ts`, `client.ts`, `mock-client.ts`, `logging.ts`, `index.ts` |
| Tests | 50/50 (unitarios, datos ficticios) |

**Conclusión: la arquitectura de Fase 4 es correcta y suficiente para Fase 5 — no se reescribe nada.** El único trabajo pendiente es reemplazar `types/raw.ts` + `schemas/*.ts` + crear `http-client.ts` cuando exista documentación real, tal como ya preveía `src/lib/workera/README.md`.

---

## 2. Búsqueda de documentación real (resultado)

Búsqueda exhaustiva realizada en esta fase:
- Todo el repositorio (`docs/`, y cualquier PDF/Markdown/OpenAPI/Swagger/JSON/Postman en cualquier carpeta, excluyendo `node_modules`/`.git`/`.next`).
- `C:\Users\SEBAS\Downloads` y `C:\Users\SEBAS\Desktop` (recursivo), por si existía documentación descargada fuera del repo (mismo lugar donde se encontró el Excel real de asistencia en una fase anterior).

**Resultado: no se encontró ningún archivo de documentación real de Workera en ningún lado.** Los únicos archivos relacionados son:
- `docs/PRE_FASE2_WORKERA_VALIDATION.md` — `INTERNAL_ASSUMPTION` (nuestro propio análisis, Fase 0/2)
- `docs/WORKERA_API_REQUIREMENTS.md` — `INTERNAL_ASSUMPTION` (nuestro propio checklist, Fase 4)
- `src/lib/workera/mock-client.ts` — explícitamente **no es evidencia de la API real** (datos ficticios "... Demo", tal como exige el encargo)

**Documentation found: NO. Sufficient for connection: NO.**

---

## 3. Capability Matrix

Ninguna capacidad se marca `CONFIRMED` ni `NOT_SUPPORTED` sin evidencia — al no existir documentación real, **todas quedan `UNKNOWN`**.

| Capability | Status |
|---|---|
| Employees | `UNKNOWN` |
| Attendance / clock records | `UNKNOWN` |
| Absences | `UNKNOWN` |
| Vacations | `UNKNOWN` |
| Medical leave | `UNKNOWN` |
| Mutual leave | `UNKNOWN` |
| Overtime | `UNKNOWN` |
| Supervisor relationship | `UNKNOWN` |
| Departments/groups | `UNKNOWN` |
| Updated-at/version information | `UNKNOWN` |
| Pagination | `UNKNOWN` |
| Date filtering | `UNKNOWN` |
| Webhooks | `UNKNOWN` |
| Write operations | `UNKNOWN` |
| Overtime approval write-back | `UNKNOWN` |

Coincide exactamente con `capabilities.ts` (Fase 4) — no hubo que corregir ningún valor porque ninguno se había marcado `CONFIRMED_AVAILABLE` sin evidencia.

---

## 4. Información mínima que falta para conectar

Lista exacta (subconjunto priorizado de `docs/WORKERA_API_REQUIREMENTS.md`, sin duplicar el detalle completo):

1. Base URL oficial (producción y sandbox si existe).
2. Método de autenticación exacto (API key / OAuth2 / Basic / token por request) y cómo se renueva.
3. Endpoint real de listado de empleados + un payload de ejemplo real.
4. Endpoint real de marcaciones/asistencia + payload de ejemplo.
5. Endpoint real de ausencias (vacaciones/licencias/mutual/permisos) + vocabulario real de tipos.
6. Nombre real del campo de ID externo estable por empleado.
7. Nombre real del campo de departamento/área/grupo (para poder configurar el mapeo hacia `PRODUCTION`/`INSTALLATION`/`ADMINISTRATION` — hoy sin ninguna hipótesis cargada).
8. Formato exacto de timestamps y timezone en que Workera los entrega/espera.
9. Mecanismo de paginación real.
10. Filtros de fecha soportados.
11. Rate limits informados por Workera.
12. Formato de respuesta de error.
13. Si existe `updated_at`/versionado por registro, o si hay que usar hash para detectar cambios.
14. Si existen webhooks o solo polling.
15. Si existe algún endpoint de escritura (en particular, autorización de horas extra) y su contrato exacto.

Ninguno de estos 15 puntos está confirmado hoy.

---

## 5. Credenciales

**No se solicitó ni se recibió ninguna credencial en esta conversación**, conforme a la instrucción explícita del encargo. Cuando existan credenciales reales, deben configurarse **localmente** como variables de entorno server-only — nunca en código, README, docs, migraciones, tests ni con prefijo `NEXT_PUBLIC_`.

Nombres de variable ya declarados en `.env.example` desde Fase 4 (genéricos, no definitivos — se ajustan cuando se confirme el mecanismo real de autenticación):

```
WORKERA_PROVIDER=mock
WORKERA_BASE_URL=
WORKERA_CREDENTIAL=
WORKERA_REQUEST_TIMEOUT_MS=10000
```

No se agregó ni se inventó ningún nombre de variable adicional en esta fase — no hay información nueva que justifique un nombre más específico (ej. `WORKERA_API_KEY` vs. `WORKERA_OAUTH_CLIENT_SECRET` depende de un mecanismo de auth que sigue sin confirmarse).

---

## 6. Siguiente acción

1. Obtener de Workera (o de quien administre la relación comercial/técnica con Workera) la documentación oficial de su API — idealmente OpenAPI/Swagger o un documento técnico equivalente — y las 15 respuestas de la sección 4.
2. Colocar esa documentación dentro del repositorio (ej. `docs/workera-api/`) para que quede trazada y disponible para retomar Fase 5.
3. Cuando exista, retomar Fase 5 (Case B): reescribir `types/raw.ts` y `schemas/*.ts` contra la forma real, implementar `http-client.ts`, y ejecutar la prueba read-only mínima descrita en el encargo (1 empleado o un rango corto de asistencia, sin escribir a Supabase) antes de considerar la sincronización automática.

---

## Resultado

```
REAL_WORKERA_API_CONNECTED: NO
PHASE_5_BLOCKED_WAITING_FOR_WORKERA_API
```
