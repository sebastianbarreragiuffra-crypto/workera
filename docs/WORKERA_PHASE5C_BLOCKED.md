# Fase 5C — Conexión real read-only con Workera (bloqueada)

**Estado: `PHASE_5C_BLOCKED_DOCUMENTATION` (equivalente a `PHASE_5C_BLOCKED_AUTH_DOCUMENTATION` del encargo — el bloqueo es sobre el mecanismo de autenticación y los endpoints, no sobre la disponibilidad de credenciales).** No se implementó `HttpWorkeraClient`. No se realizó ninguna request HTTP real contra Workera. No se probó ningún endpoint, header ni combinación de autenticación. No se escribió a Supabase.

Actualiza `docs/WORKERA_PHASE5B_BLOCKED.md` (que sigue vigente para su contenido) con dos hechos nuevos.

---

## 1. Qué cambió desde Fase 5B

`.env.local` (no trackeado — verificado nuevamente con `git check-ignore -v .env.local` y `git ls-files .env.local`) ahora contiene las tres variables:

```
WORKERA_API_USER  = <presente, no inspeccionado>
WORKERA_API_KEY   = <presente, no inspeccionado>
WORKERA_BASE_URL  = <presente, no inspeccionado>
```

Verificación exclusivamente booleana (sin `cat`, `Get-Content`, `echo` ni ningún comando que hubiera impreso un valor):

```
WORKERA_API_USER configured: YES
WORKERA_API_KEY configured: YES
WORKERA_BASE_URL configured: YES
.env.local ignored: YES
.env.local tracked: NO
```

El encargo de esta fase menciona además, como **información de partida a confirmar, no como hecho confirmado**:

- Base URL: `https://workera.com/apiClient/v1`
- Nombres de servicio potenciales: `employee`, `attendanceData`, `department`, `overtimeAuthorization`

## 2. Por qué esto sigue sin ser suficiente para conectar

El propio encargo es explícito: *"NO confíes ciegamente en estos nombres. Confírmalos contra documentación oficial antes de usarlos."* Se realizó una búsqueda exhaustiva de esa documentación oficial (repetición de la búsqueda de Fase 5/5B, ampliada a los términos `apiClient`, `swagger`, `openapi`, `postman` sobre todo el repositorio y sobre `C:\Users\SEBAS\Downloads` y `C:\Users\SEBAS\Desktop` de forma recursiva) y **no se encontró ningún documento oficial de Workera** — ni PDF, ni OpenAPI/Swagger, ni colección de Postman, ni ningún archivo que confirme:

| Dato crítico | Estado |
|---|---|
| Mecanismo exacto de autenticación (¿header `Authorization`? ¿`X-API-User`/`X-API-Key` separados? ¿Basic Auth con `API_USER` como usuario y `API_KEY` como password? ¿query params?) | `UNKNOWN` |
| Si `apiClient/v1` es efectivamente el path base correcto y completo, o si falta un prefijo/sufijo | `UNKNOWN` |
| Si `employee`, `attendanceData`, `department`, `overtimeAuthorization` son nombres de endpoint reales | `UNKNOWN` — mencionados por el encargo como hipótesis, no como documentación |
| Método HTTP de cada servicio (¿todos GET? ¿alguno requiere POST incluso para leer?) | `UNKNOWN` |
| Formato de respuesta (JSON, estructura, envoltorio de paginación) | `UNKNOWN` |
| Formato de error | `UNKNOWN` |
| Paginación real | `UNKNOWN` |
| Filtros de fecha reales | `UNKNOWN` |
| Mecanismo de `branchOffice`/`department` | `UNKNOWN` |

## 3. Por qué no se intentó ninguna request

El gate anti-invención de esta fase es explícito y se respetó sin excepción: *"NO pruebes combinaciones arbitrarias de headers. NO pruebes endpoints inventados. NO hagas fuzzing de la API. NO intentes autenticación por ensayo/error con múltiples formatos."*

Con credenciales reales pero sin confirmación documentada del mecanismo de autenticación ni de los endpoints, cualquier request —incluida una simple request de descubrimiento a `https://workera.com/apiClient/v1` con un header adivinado— sería exactamente ese ensayo/error prohibido, contra un servidor de producción real con una credencial real. No se hizo ninguna.

## 4. Qué se necesita para desbloquear Fase 5C

Uno de los siguientes, con evidencia verificable:

- Documentación oficial de Workera (OpenAPI/Swagger/PDF/Postman/documento técnico) que confirme el mecanismo de autenticación exacto y al menos un endpoint de lectura (empleados o departamentos/sucursales).
- O confirmación explícita y por escrito de quien administra la relación técnica con Workera, especificando: (a) el header o parámetro exacto donde va `WORKERA_API_USER` y `WORKERA_API_KEY`, (b) si `https://workera.com/apiClient/v1` es la base URL completa o requiere un sufijo adicional por servicio, (c) el nombre y método HTTP real de al menos un endpoint de lectura.

## 5. Verificación de seguridad de esta etapa

- Ninguna de las tres credenciales se imprimió, mostró, copió ni incluyó en ningún archivo de este repositorio, en ningún momento de esta sesión.
- No se agregó código nuevo que lea `process.env.WORKERA_API_USER`, `process.env.WORKERA_API_KEY` ni `process.env.WORKERA_BASE_URL` — no había forma segura de usarlos sin el mecanismo de autenticación confirmado, así que `config.ts` y `src/lib/workera/` quedan exactamente como en Fase 4/5B.
- No se realizó ninguna conexión de red hacia `workera.com` ni ningún otro host relacionado.
- `supabase/` permanece intacto — sin migraciones nuevas, sin escrituras.
- Regresión confirmada: 119/119 tests pgTAP, 50/50 tests del adapter, lint/typecheck/build limpios.

## Resultado

```
REAL_WORKERA_API_CONNECTED: NO
Workera write requests: 0
Workera read requests: 0
PHASE_5C_BLOCKED_DOCUMENTATION
```
