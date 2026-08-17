# Requisitos de API — qué necesitamos de Workera antes de Fase 5

Este documento lista exactamente qué debemos obtener/confirmar de Workera para poder implementar `HttpWorkeraClient` (Fase 5). **No se ha encontrado documentación real de Workera en este repositorio** — todo lo que sigue está marcado `WAITING_FOR_WORKERA_DOCUMENTATION` salvo que se indique lo contrario explícitamente. Consolida y actualiza el checklist original de `docs/PRE_FASE2_WORKERA_VALIDATION.md` sección 5, sin duplicarlo — este es el documento vigente para Fase 5 en adelante.

---

## Acceso y autenticación

| Ítem | Estado |
|---|---|
| Documentación oficial (Swagger/OpenAPI o equivalente) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Base URL(s) (producción, sandbox si existe) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Mecanismo de autenticación (API key, OAuth2, token por request, Basic Auth, etc.) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Cómo se renueva/rota la credencial | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Rate limits (requests/minuto, política de backoff informada por Workera) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Formato de errores de la API (¿JSON con código propio? ¿solo status HTTP?) | `WAITING_FOR_WORKERA_DOCUMENTATION` |

## Entidades y campos

| Ítem | Estado |
|---|---|
| Endpoint de listado de empleados + ejemplo de payload real | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| ID externo estable por empleado (nombre exacto del campo) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| ¿RUT disponible? ¿En qué endpoint/campo? | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Empresa/sucursal/centro de costo/área/cargo — ¿campos directos o hay que inferirlos? | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Nombre real del campo de grupo/área (para poblar el mapping de `mappers/employee-group.ts` — hoy vacío a propósito) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Relación empleado↔supervisor: ¿existe? ¿granularidad? | `WAITING_FOR_WORKERA_DOCUMENTATION` — nuestra base ya es la fuente de verdad operativa (`docs/PRE_FASE2_WORKERA_VALIDATION.md` sección 6), esto es solo para saber si sirve como semilla |
| Endpoint de marcaciones + ejemplo real | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| ¿Marcación cruda vs. asistencia procesada? | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| ¿Workera calcula horas trabajadas, o solo entrega marcaciones? | `WAITING_FOR_WORKERA_DOCUMENTATION` — crítico, define si `overtime_records`/atrasos siguen siendo cálculo 100% interno (asumido hoy, ver Fase 2 docs) |
| ¿Workera calcula/expone horas extra? | `WAITING_FOR_WORKERA_DOCUMENTATION` — capability `overtime` en `capabilities.ts`, hoy `UNKNOWN`; el dominio de cálculo (120 min, HH50/HH100, bono) es nuestro sin importar la respuesta (secciones 25-27 del encargo Fase 4) |
| Endpoint de licencias médicas + campos disponibles (sin pedir diagnóstico) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Endpoint de vacaciones + fechas/estado | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Vocabulario real de tipos de ausencia/permiso que usa Workera (para poblar `mappers/absence.ts` — hoy vacío) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Estados de empleado (activo/con licencia/vacaciones) y si son mutuamente excluyentes | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| ¿Existe un código de estado diario análogo a P/F/F-P/F-J/P-L/P-M/V/L/L-M/R/? | `WAITING_FOR_WORKERA_DOCUMENTATION` — campo especulativo `status_code` en `types/raw.ts` a confirmar o eliminar |

## Escritura

| Ítem | Estado |
|---|---|
| ¿Endpoint para autorizar/rechazar horas extra desde fuera de Workera? | `WAITING_FOR_WORKERA_DOCUMENTATION` — capability `writeOvertimeApproval`, hoy `UNKNOWN` |
| Si existe, payload esperado y confirmación de respuesta | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Control de concurrencia (¿alguien más pudo modificar el registro en Workera mientras tanto?) | `WAITING_FOR_WORKERA_DOCUMENTATION` |

## Operación

| Ítem | Estado |
|---|---|
| Paginación real: ¿page/pageSize, offset, cursor? | `WAITING_FOR_WORKERA_DOCUMENTATION` — `WorkeraPageToken` (types/common.ts) es deliberadamente opaco para no asumir esto |
| Filtros por fecha soportados (rango máximo, granularidad) | `WAITING_FOR_WORKERA_DOCUMENTATION` |
| Timezone en que Workera entrega/espera fechas y horas | `WAITING_FOR_WORKERA_DOCUMENTATION` — crítico, ver `mappers/instant.ts` |
| ¿Webhooks disponibles, o solo polling? | `WAITING_FOR_WORKERA_DOCUMENTATION` — capability `webhooks`, hoy `UNKNOWN` |
| ¿Los registros pueden modificarse después de creados? ¿Existe `updated_at` por registro? | `WAITING_FOR_WORKERA_DOCUMENTATION` — determina si la futura detección de `SYNC_CONFLICT` puede usar `updated_at` o debe depender de hash (ver `docs/BUSINESS_RULES_PRE_PHASE2.md`) |
| ¿IDs de registro individuales para asistencia/ausencias, o solo (empleado, fecha)? | `WAITING_FOR_WORKERA_DOCUMENTATION` — define la estrategia de upsert idempotente de la futura sincronización |

---

## Qué NO depende de esta lista (ya decidido, no bloquea Fase 5)

- El modelo interno normalizado (`types/normalized.ts`) — estable independientemente de la forma real de Workera.
- Que horas extra/atrasos/bono son cálculo de nuestro dominio, no de Workera — decidido en `docs/BUSINESS_RULES_PRE_PHASE2.md`, no cambia aunque Workera resulte exponer algo similar.
- Que supervisor↔trabajador vive en nuestra base como fuente de verdad operativa — Workera, si expone algo, es solo una semilla opcional.
- La arquitectura de capas (`raw → schema → mapper → normalizado`) — el reemplazo de Fase 5 es de `types/raw.ts`, `schemas/*`, y la implementación de `HttpWorkeraClient`; el resto del adaptador y toda la aplicación aguas abajo no cambian.

## Cómo se usa este documento en Fase 5

Cuando se consiga documentación/acceso real:
1. Reemplazar `types/raw.ts` con la forma real confirmada (no incremental — completo).
2. Reescribir `schemas/*.ts` contra esa forma real.
3. Poblar `mappers/employee-group.ts` y `mappers/absence.ts` con las tablas de mapeo reales (o cargarlas desde configuración).
4. Implementar `HttpWorkeraClient` en un archivo nuevo (`http-client.ts`), implementando la misma interfaz `WorkeraClient` — ningún consumidor fuera de `src/lib/workera/` debería necesitar cambios.
5. Actualizar `capabilities.ts` de `UNKNOWN` a `CONFIRMED_AVAILABLE`/`CONFIRMED_UNAVAILABLE` según se confirme cada capacidad.
6. Mover los tests de `tests/workera/contract/` de "no ejecutados" a parte del pipeline normal, con credenciales de sandbox si Workera las provee.
