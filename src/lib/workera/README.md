# workera/

Adaptador desacoplado hacia Workera. **Nada fuera de esta carpeta debe conocer URLs reales, endpoints reales, nombres exactos de campos del JSON externo, API keys, headers ni peculiaridades de Workera.** El resto de la aplicación programa exclusivamente contra `WorkeraClient` y el modelo normalizado (`types/normalized.ts`), importados desde `index.ts`.

## Estado

**No hay conexión real a Workera todavía.** No existe documentación ni credenciales de Workera verificadas en este repositorio — ver `docs/WORKERA_API_REQUIREMENTS.md` para el checklist exacto de lo que falta. Todo lo construido aquí usa `MockWorkeraClient` con datos 100% ficticios.

## Arquitectura

```
Workera API (real, Fase 5)
        ↓
types/raw.ts            ⚠️ placeholder especulativo, no confirmado — ver advertencia en el archivo
        ↓
schemas/*.ts             validación runtime (Zod) — rechaza con WorkeraValidationError si no calza
        ↓
mappers/*.ts              raw validado -> modelo normalizado, nunca al revés
        ↓
types/normalized.ts       modelo interno estable — esto es lo que el resto de la app conoce
        ↓
client.ts (WorkeraClient) interfaz pública, implementada por mock-client.ts (hoy) / http-client.ts (Fase 5)
```

## Archivos

| Archivo | Rol |
|---|---|
| `index.ts` | Único punto de entrada público. Importar desde aquí, no desde archivos internos. |
| `client.ts` | Interfaz `WorkeraClient` + `createWorkeraClient()` (factory: decide mock vs. http según config, fail-closed en producción). |
| `mock-client.ts` | `MockWorkeraClient` — datos ficticios (`"... Demo"`), nunca trabajadores reales. Implementa la misma interfaz que usará el futuro cliente real. |
| `http-client.ts` | **No existe todavía.** Se crea en Fase 5 cuando haya documentación/credenciales reales. |
| `config.ts` | Configuración server-only (`import "server-only"`). Fail-closed: en producción, sin `WORKERA_PROVIDER=http` + `WORKERA_BASE_URL`, lanza `WorkeraConfigurationError` — nunca cae al mock en silencio. |
| `capabilities.ts` | Qué capacidades de Workera están confirmadas (`UNKNOWN` en casi todo hoy — no fingir soporte). |
| `errors.ts` | Errores tipados (`WorkeraValidationError`, `WorkeraNetworkError`, etc.) + `isRetryableWorkeraError()`. |
| `logging.ts` | Logging estructurado seguro (server-only) — solo campos explícitamente permitidos, nunca payloads completos ni credenciales. |
| `types/raw.ts` | ⚠️ Forma placeholder especulativa del JSON externo. Se reemplaza por completo en Fase 5. |
| `types/normalized.ts` | Modelo interno estable. |
| `types/common.ts` | `LocalDateRange`, paginación opaca (`WorkeraPageToken`) — no asumen page/pageSize ni cursor como única forma. |
| `types/employee-group.ts`, `types/absence-type.ts`, `types/attendance-status.ts` | Tipos de los catálogos internos + forma de las tablas de mapeo (vacías por defecto — ver mappers). |
| `schemas/*.ts` | Validación Zod de `types/raw.ts`. |
| `mappers/*.ts` | `raw` validado → `normalized`. `mappers/employee-group.ts` y `mappers/absence.ts` reciben la tabla de mapeo como parámetro (nunca hardcodeada) — sin entrada, el resultado es `UNMAPPED`/`UNKNOWN_EXTERNAL_STATUS`, nunca una asignación adivinada. |

## Regla de seguridad — server-only

`config.ts`, `client.ts`, `mock-client.ts`, `logging.ts` e `index.ts` importan `"server-only"` — Next.js falla el build si un Client Component los importa, directa o transitivamente. Ninguna variable de entorno de Workera lleva jamás el prefijo `NEXT_PUBLIC_`.

## Cómo conectar la API real (Fase 5)

1. Confirmar el checklist de `docs/WORKERA_API_REQUIREMENTS.md`.
2. Reemplazar `types/raw.ts` por la forma real (no parchear el placeholder — reescribirlo).
3. Reescribir `schemas/*.ts` contra la forma real.
4. Poblar las tablas de mapeo reales (`mappers/employee-group.ts`, `mappers/absence.ts`, `mappers/attendance-status.ts` reciben la tabla por parámetro — la fuente de esa tabla en producción puede ser configuración/una tabla administrable, a decidir en Fase 5).
5. Crear `http-client.ts` implementando `WorkeraClient`, con timeout (`config.ts` ya expone `requestTimeoutMs`) y la estrategia de reintento documentada en `errors.ts` (`isRetryableWorkeraError`).
6. Actualizar `capabilities.ts`.
7. Activar `tests/workera/contract/` contra un sandbox real si Workera lo provee.

Ningún consumidor fuera de `src/lib/workera/` debería necesitar cambios — programan contra `WorkeraClient`/`types/normalized.ts`, no contra la implementación concreta.

## Testing

```bash
npm run test:workera
```

Usa el test runner nativo de Node (`node:test`) vía `tsx` — no se agregó Jest/Vitest porque el proyecto no tenía ningún runner de TypeScript configurado y esta es la opción más liviana compatible. `--conditions=react-server` neutraliza el guard de `server-only` durante los tests (mismo mecanismo que usa Next.js internamente), sin debilitar la protección real en build/runtime.
