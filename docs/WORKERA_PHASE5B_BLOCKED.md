# Fase 5B — Conexión real read-only con Workera (bloqueada)

**Estado: `PHASE_5B_BLOCKED_MISSING_WORKERA_CONNECTION_DETAILS`.** No se implementó `HttpWorkeraClient`. No se realizó ninguna request real. No se probó ninguna URL. No se escribió a Supabase.

Actualiza `docs/WORKERA_PHASE5_READINESS.md` (que sigue vigente para el resto de su contenido) con un hecho nuevo: **ahora existe una credencial real configurada localmente**, pero eso por sí solo no es suficiente para conectar.

---

## 1. Qué cambió desde `docs/WORKERA_PHASE5_READINESS.md`

`.env.local` (no trackeado, correctamente ignorado — verificado con `git check-ignore -v .env.local` y `git ls-files .env.local`) ahora contiene:

```
WORKERA_API_KEY = <presente, valor no inspeccionado ni mostrado>
```

`WORKERA_API_KEY configured: YES` — confirmado de forma booleana únicamente (no se ejecutó `cat`, `Get-Content`, `echo` ni ningún comando que hubiera impreso el valor).

## 2. Por qué esto NO es suficiente para conectar

Tener una API key no implica saber **dónde** ni **cómo** usarla. Faltan, sin excepción, los siguientes datos críticos — ninguno se infiere ni se adivina:

| Dato crítico | Estado |
|---|---|
| Base URL de la API | `UNKNOWN` — `.env.local` no define `WORKERA_BASE_URL` |
| Formato de autenticación (¿header `Authorization: Bearer`? ¿`X-API-Key`? ¿query param? ¿Basic con un API User + esta key como password?) | `UNKNOWN` |
| API User / usuario asociado a la key, si el mecanismo lo requiere | `UNKNOWN` |
| Endpoint real de empleados | `UNKNOWN` |
| Endpoint real de asistencia | `UNKNOWN` |
| Endpoint real de ausencias | `UNKNOWN` |
| Documentación oficial (OpenAPI/Swagger/PDF/Postman) | **No encontrada** — se repitió la búsqueda exhaustiva de Fase 5 (repo completo + `Downloads`/`Desktop`, incluyendo archivos más recientes que la propia credencial) y no apareció ningún artefacto nuevo |

Todos los demás puntos del checklist de `docs/WORKERA_API_REQUIREMENTS.md` (paginación, timezone, rate limits, formato de error, `updated_at`, webhooks, escritura) siguen igual de `UNKNOWN` que en Fase 5.

## 3. Por qué no se intentó adivinar

El encargo de esta fase es explícito y se respeta sin excepción: sin Base URL confirmada ni formato de autenticación confirmado, cualquier request sería fuzzing contra un dominio que ni siquiera conocemos — no "probar rutas hipotéticas como `/api/employees`", no construir una Base URL a partir de suposiciones (ej. `https://api.workera.cl` o similar), no asumir que la key funciona como Bearer token porque es lo más común. Cualquiera de estas acciones sería exactamente el tipo de "integración ficticia" que el encargo pide evitar explícitamente, y además podría generar tráfico no autorizado contra un dominio equivocado con una credencial real.

## 4. Qué se necesita para desbloquear Fase 5B

Como mínimo, uno de los siguientes:

- Documentación oficial de Workera (OpenAPI/Swagger/PDF/Postman collection/documento técnico) con Base URL, mecanismo de autenticación y al menos un endpoint de lectura.
- O, en ausencia de documentación formal, confirmación explícita y por escrito (de quien administra la relación con Workera) de: Base URL exacta, cómo se usa `WORKERA_API_KEY` en la request (header exacto o parámetro exacto), y si se requiere un API User adicional.

Cuando exista, se agrega a `.env.local` (nunca a Git):

```
WORKERA_BASE_URL=
WORKERA_API_KEY=       (ya presente)
```

y, si el mecanismo real resulta requerir un usuario adicional, un tercer nombre de variable — a definir en ese momento, no ahora, para no inventar un nombre que no corresponda al mecanismo real.

## 5. Verificación de seguridad de esta etapa

- La credencial nunca se imprimió, mostró, copió ni incluyó en ningún archivo de este repositorio.
- `WORKERA_API_KEY` no aparece en ningún archivo bajo `src/` ni en el bundle de producción (`.next/static`) — confirmado por búsqueda directa.
- No se agregó ningún código nuevo que lea `process.env.WORKERA_API_KEY` — no había dónde usarlo de forma segura sin Base URL/formato confirmado, así que no se tocó `config.ts` ni se creó `http-client.ts`.
- `supabase/` permanece intacto — sin migraciones nuevas.

## Resultado

```
REAL_WORKERA_API_CONNECTED: NO
PHASE_5B_BLOCKED_MISSING_WORKERA_CONNECTION_DETAILS
```
