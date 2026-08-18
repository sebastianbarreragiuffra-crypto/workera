# Fase 5C — Conexión real read-only con Workera

Estado: `IMPLEMENTED` — primera conexión real, de solo lectura, contra la API pública de Workera, verificada con una llamada real a `GET /attendanceData`. **No hay sincronización, cálculo de reglas de negocio, ni UI todavía** — ver sección "Lo que esta fase NO hace" al final.

## 1. Fuente oficial utilizada

Manual oficial de Workera, provisto directamente por el usuario (capturas del manual, no de blogs/foros/terceros). Confirma explícitamente:

> "Utiliza los valores de API_USER y API_KEY como encabezados en las consultas REST de cada funcionalidad API."

Esto reemplaza el bloqueo de la sesión anterior (`PHASE_5C_BLOCKED_DOCUMENTATION`), donde la documentación pública indexada en `help.workera.com` confirmaba la existencia de `API_USER`/`API_KEY` pero no el mecanismo exacto de transmisión (los ejemplos de Postman visibles en esa página solo mostraban la pestaña "Params", nunca "Headers"/"Authorization" expandida).

## 2. Autenticación

- **Headers HTTP**: `API_USER` y `API_KEY` (nombres literales, confirmados por el manual).
- `API_USER` = correo electrónico asociado a la cuenta de Workera.
- `API_KEY` = código alfanumérico de 32 caracteres.
- Variables de entorno server-only (nunca `NEXT_PUBLIC_*`): `WORKERA_API_USER`, `WORKERA_API_KEY`, `WORKERA_BASE_URL`.

## 3. Base URL

```
https://workera.com/apiClient/v1/{servicio}
```

Configurada como `WORKERA_BASE_URL=https://workera.com/apiClient/v1`; `HttpWorkeraClient` concatena `/attendanceData` (y en el futuro, otros servicios) sobre esa base.

## 4. Endpoint verificado: `GET /attendanceData`

Devuelve registros/eventos de marcación (activos, modificados y eliminados según el manual) para un rango de fechas. Respuesta paginada, **20 elementos por página**.

### Parámetros

| Parámetro | Tipo | Requerido | Notas |
|---|---|---|---|
| `start` | Date `yyyy-MM-dd` | Sí | |
| `end` | Date `yyyy-MM-dd` | Sí | |
| `branchOffice` | String | No | Código de sucursal |
| `department` | String | No | Código de departamento |
| `employees` | String | No | Códigos ficha separados por coma, sin espacios |
| `attTypes` | String | No | Valores documentados: `RELOJ`, `MOVIL`, `SISTEMA`, `PORTAL`, `DESKTOP` |
| `page` | Integer | Sí (default 1) | |

La primera prueba real de esta fase usó exclusivamente `start`/`end`/`page` — `branchOffice`/`department`/`employees`/`attTypes` se dejaron sin enviar deliberadamente (el manual los marca opcionales).

### Forma de la respuesta

```
{ page, totalPages, pageResult, totalResult, requestInfo?, data: AttendanceData[] }
```

Validada en `src/lib/workera/schemas/attendance-event.ts` (`rawWorkeraAttendanceDataResponseSchema`) — todo campo no confirmado como "siempre presente" se modela `nullish()`/`optional()`, nunca se asume.

### `AttendanceData` (evento individual)

| Campo | Notas |
|---|---|
| `employee` | Sub-objeto reducido: `code`, `deviceCode`, `identification`, `name`, `lastName`, `branchOffice`, `department`, `employeeStatus`, `companyIdentification`, `companyName` — **distinto** del `EmployeeFullData` de `GET /employee` |
| `attendanceDate` | `yyyy-MM-dd'T'HH:mm:ss` — el manual **no demuestra offset/UTC**. Se conserva tal cual (`attendanceTimestampRaw`), sin conversión, hasta confirmar el offset real. |
| `attendanceType` | Entero 0-5, ver sección 5 |
| `attendanceStatus` | `ACTIVO` \| `INACTIVO` \| `MODIFICADO` — valor no reconocido se preserva como `UNKNOWN_EXTERNAL_STATUS` + `externalAttendanceStatus` con el original |
| `origin` / `originCode` | Reloj biométrico, móvil, sistema, portal del trabajador, software desktop — sin regla de negocio asociada todavía |
| `address`, `deviceName`, `checksum`, `isMobile`, `coordinatesMobile`, `precision` | Opcionales, no siempre presentes |

**Workera entrega EVENTOS, no un par `clock_in`/`clock_out` ya resuelto.** El adapter conserva cada evento tal como llega (`NormalizedWorkeraAttendanceEvent`, `src/lib/workera/types/attendance-event.ts`) — colapsar eventos en un clock-in/clock-out definitivo por trabajador+día queda **deliberadamente fuera de alcance** de esta fase; es responsabilidad de una futura capa de sincronización/reglas de negocio.

## 5. `attendanceType` (confirmado)

| Código | Significado |
|---|---|
| 0 | Entrada |
| 1 | Salida |
| 2 | Salida extraordinaria |
| 3 | Entrada extraordinaria |
| 4 | Inicio descanso |
| 5 | Término descanso |

## 6. `originCode` (confirmado)

`RELOJ`, `MOVIL`, `SISTEMA`, `PORTAL`, `DESKTOP` — corresponden a dispositivo biométrico, dispositivo móvil, sistema, portal del trabajador y software Workera para Windows respectivamente. Sin regla de negocio asociada en esta fase.

## 7. Paginación

`page`/`totalPages`/`pageResult`/`totalResult` en cada respuesta. Esta fase consulta únicamente **página 1** — no recorre todas las páginas de la empresa.

## 8. Timestamp / timezone — pendiente

`attendanceDate` usa el formato `yyyy-MM-dd'T'HH:mm:ss`, pero el manual oficial **no demuestra si incluye offset UTC o es hora local sin marcar**. La aplicación usa `America/Santiago` para "hoy", pero **no se aplicó ninguna conversión de timezone destructiva** sobre el valor recibido — se conserva crudo en `attendanceTimestampRaw`. Confirmar el offset real (o su ausencia) es un prerequisito antes de que una futura capa de sincronización pueda interpretar estos timestamps de forma confiable.

## 9. Errores

Formato general documentado: `{ "result": "CORRECTO"|"ADVERTENCIA"|"ERROR", "messages": [...] }`. `HttpWorkeraClient` además clasifica por código HTTP: `401` → `WorkeraAuthenticationError`, `403` → `WorkeraAuthorizationError`, `429` → `WorkeraRateLimitError` (con `retryAfterMs` si Workera envía `Retry-After`), `5xx` → `WorkeraServerError`, timeout → `WorkeraTimeoutError`, fallo de red → `WorkeraNetworkError`, payload que no cumple el schema → `WorkeraValidationError`. Ningún error incluye headers de autenticación, payload crudo, ni PII.

## 10. Resultado real de la conexión (Fase 5C)

Verificado con una llamada real, ejecutada una sola vez, contra `GET /attendanceData` para la fecha de hoy en `America/Santiago`, página 1, sin `branchOffice`/`department`/`employees`/`attTypes`:

- **HTTP status**: 200
- **page / totalPages / pageResult / totalResult**: 1 / 2 / 20 / 37
- **records received**: 20
- **validation**: PASS (Zod, `unknown → schema → DTO validado`)
- **mapping**: PASS (`DTO validado → NormalizedWorkeraAttendanceEvent[]`, sin colapsar a clock_in/clock_out)
- **TODAY_ATTENDANCE_READ = PASS**

Sin PII mostrada en ningún momento — ni en consola, ni en este documento, ni en ningún archivo del repositorio. Ningún payload real se persistió.

## 11. Arquitectura

```
WorkeraClient (interfaz)
    ├── MockWorkeraClient   — datos ficticios (Fase 4)
    └── HttpWorkeraClient   — API real (Fase 5C), server-only
```

`HttpWorkeraClient` (`src/lib/workera/http-client.ts`) implementa `WorkeraClient` pero, deliberadamente, `getEmployees`/`getAttendance` (forma colapsada)/`getAbsences` lanzan `WorkeraConfigurationError` con un mensaje explícito de "no implementado en esta fase" — el único método real y probado es `getAttendanceEvents(params)`, a nivel de evento individual. `createWorkeraClient()` (`client.ts`) ya construye `HttpWorkeraClient` cuando `WORKERA_PROVIDER=http`, con las credenciales validadas por `getWorkeraConfig()`.

## 12. Validación en runtime

Todo payload de Workera pasa por: `unknown → Zod (rawWorkeraAttendanceDataResponseSchema) → RawWorkeraAttendanceDataResponseParsed → mapWorkeraAttendanceEvent → NormalizedWorkeraAttendanceEvent[]`. Ningún cast inseguro (`as Something` sobre `response.json()`); un payload que no cumple el schema nunca llega al mapper — falla con `WorkeraValidationError` con el detalle de qué campo no calzó.

## 13. Pruebas

- **Unitarias con mock de `fetch`** (`http-client.test.ts`): 200 válido, 401, 403, 429 (con `Retry-After`), 500, timeout, JSON inválido, payload que no cumple el schema, mapeo de los 6 `attendanceType`, `attendanceStatus` desconocido → `UNKNOWN_EXTERNAL_STATUS`, metadata de paginación, headers `API_USER`/`API_KEY` con los valores configurados, redacción de PII en logs, y confirmación de que `getEmployees`/`getAttendance`/`getAbsences` siguen sin implementar. Todas con credenciales ficticias de test — ninguna llama a la red real.
- **Contract test opt-in** (`contract.test.ts`): `WORKERA_CONTRACT_TESTS=1 npm run test:workera`. OFF por defecto (no corre en CI ni en un `npm run test:workera` normal). Solo lectura, solo página 1, no persiste el payload, no imprime PII.

## 14. Lo que esta fase NO hace

- No escribe en Workera (cero `POST`/`PUT`/`DELETE` ejecutados).
- No escribe en Supabase (cero inserts/updates en `employees`, `attendance_records`, `sync_runs`, etc. — `supabase/` sin cambios).
- No implementa sincronización automática ni scheduler.
- No calcula atrasos, horas extra, HH50/HH100, bono, ni ninguna regla de negocio.
- No colapsa eventos en `clock_in`/`clock_out` definitivos.
- No implementa `getEmployees`/`getAttendance` (forma colapsada)/`getAbsences` en `HttpWorkeraClient`.
- No construye ninguna UI.
- No confirma el offset de timezone de `attendanceDate` (pendiente, sección 8).
