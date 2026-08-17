# Validación técnica pre-Fase 2 — Integración Workera

Estado: preparación. **No contiene DDL, migraciones ni esquema definitivo.** Objetivo: no diseñar tablas basándonos en supuestos sobre una API que todavía no hemos confirmado.

---

## 1. Auditoría corta de Fase 1

Resultado: **Fase 1 está en buen estado, con un defecto ya corregido.**

| Ítem | Estado |
|---|---|
| Estructura del proyecto (`src/app`, `src/lib`, `src/components`, `supabase/`) | ✅ Correcta, con `README.md` por carpeta explicando su propósito y fase |
| `ARCHITECTURE.md` | ✅ Presente, describe el flujo Frontend → Route Handlers → Workera y los límites de seguridad |
| `.gitignore` | ⚠️ → ✅ **Corregido**: el patrón `.env*` excluía también `.env.example` (confirmado con `git check-ignore -v .env.example`), por lo que la plantilla de variables nunca quedó versionada. Se agregó `!.env.example` y se comiteó (`1a2b8eb`). |
| `.env.example` | ✅ Ahora trackeado. No contiene ningún valor real, solo nombres de variable |
| Estado de Git | ✅ Working tree limpio, sin cambios pendientes inesperados |
| Secretos en el repo | ✅ Ninguno encontrado (`git grep` sobre patrones de API key/secret/service_role, sin resultados relevantes) |
| `src/lib/workera/`, `src/lib/supabase/`, `src/lib/excel/`, `src/lib/auth/` | ✅ Existen como carpetas con contrato documentado, sin código todavía (correcto para esta etapa) |

No se encontraron otros problemas. No se modificó nada más allá de la corrección puntual del `.gitignore`.

---

## 2. Diagrama conceptual: Workera → adapter → modelo interno → DB

```
┌─────────────────────────┐
│   Workera (raw data)     │   Formato, nombres de campo y semántica
│   JSON tal como lo        │   exactos: DESCONOCIDOS hasta tener
│   entrega la API real     │   documentación/acceso real.
└────────────┬──────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  src/lib/workera/  (capa adapter)     │
│  - httpClient / mockClient            │  Único lugar que conoce
│  - schemas (validación de forma)      │  la forma real del JSON
│  - mapper (raw → modelo interno)      │  de Workera.
│  - errors (normalización de fallos)   │
└────────────┬──────────────────────────┘
             │  a partir de aquí, SIEMPRE
             │  tipos internos, nunca el JSON crudo
             ▼
┌─────────────────────────────────────┐
│  Modelo interno normalizado (TS)      │  Estable aunque Workera cambie
│  Employee, AttendanceRecord,          │  su API. Es lo que el resto de
│  OvertimeRecord, AbsenceRecord, ...   │  la app (UI, route handlers,
└────────────┬──────────────────────────┘  Postgres) conoce.
             ▼
┌─────────────────────────────────────┐
│  PostgreSQL (Supabase) — Fase 2       │
└─────────────────────────────────────┘
```

**Regla clave:** ningún componente fuera de `src/lib/workera/` debe importar o inspeccionar el JSON crudo de Workera. Todo pasa por el mapper antes de tocar UI, route handlers o la base de datos. Esto es lo que nos permite diseñar Postgres en Fase 2 sin que un cambio de campo en la API de Workera obligue a una migración.

---

## 3. Modelo interno conceptual (no definitivo, no es DDL)

Estos son **tipos internos de la aplicación**, no una afirmación de qué devuelve Workera. Se ajustarán cuando tengamos la documentación real — probablemente cambien nombres, se dividan o se combinen.

```ts
// src/lib/workera/types.ts (conceptual — a confirmar en Fase 2/4)

interface Employee {
  externalId: string;        // ID estable en Workera — clave de sincronización
  identifier?: string;       // RUT u otro documento, si Workera lo expone
  fullName: string;
  company?: string;
  branch?: string;
  costCenter?: string;
  department?: string;
  position?: string;
  supervisorExternalId?: string; // solo si Workera expone esta relación (ver sección 5)
  status?: string;           // activo/inactivo, etc. — vocabulario a confirmar
}

interface ShiftAssignment {
  employeeExternalId: string;
  date: string;               // fecha lógica del turno, no necesariamente "hoy" en UTC
  scheduledStart?: string;
  scheduledEnd?: string;
}

interface AttendanceRecord {
  employeeExternalId: string;
  date: string;
  checkIn?: string;
  checkOut?: string;
  workedMinutes?: number;      // si Workera lo calcula; si no, lo derivamos nosotros
  externalRecordId?: string;   // si existe, mejor que componer employeeId+date
}

interface OvertimeRecord {
  employeeExternalId: string;
  date: string;
  minutesDetected?: number;    // lo que Workera calculó, si lo calcula
  minutesAuthorizedUpstream?: number; // si Workera ya tiene su propio flujo de autorización
  externalRecordId?: string;
}

interface AbsenceRecord {
  employeeExternalId: string;
  date: string;
  type: 'medical_leave' | 'vacation' | 'permit' | 'other'; // vocabulario a confirmar contra Workera
  startDate?: string;
  endDate?: string;
  externalRecordId?: string;
  // Nota de privacidad: sin diagnóstico ni detalle médico — ver sección 9
}

interface SupervisorAssignment {
  employeeExternalId: string;
  supervisorExternalId: string;
  source: 'workera' | 'internal'; // de dónde vino el vínculo — ver sección 5
}
```

Todo campo marcado `?` es explícitamente incierto hasta confirmar contra la API real. Ningún campo aquí se traduce automáticamente en una columna de Postgres en Fase 2 sin antes confirmar que Workera efectivamente lo entrega.

---

## 4. Estrategia anti-acoplamiento en `src/lib/workera/`

Estructura propuesta (mejora la de la Fase 0/1, más granular):

```
src/lib/workera/
  client.ts        Interfaz WorkeraClient (contrato estable, ya esbozada en Fase 0)
  httpClient.ts     Implementación real (Fase 4/5, tras confirmar API)
  mockClient.ts     Implementación simulada para desarrollo sin API real
  schemas.ts        Validación de forma del JSON crudo (ej. con Zod) — falla rápido
                     y explícito si Workera cambia su contrato, en vez de fallar
                     silenciosamente más adelante en la app
  mapper.ts         raw Workera JSON → modelo interno normalizado (sección 3)
  errors.ts         Normaliza errores de red/HTTP/autenticación de Workera a
                     errores propios de la app (ej. WorkeraAuthError, WorkeraRateLimitError)
  types.ts          Tipos internos normalizados (lo de la sección 3)
  raw-types.ts      Tipos del JSON crudo de Workera (solo se completan cuando
                     tengamos la documentación — hoy no existen todavía)
```

Por qué esta estructura y no una más simple (`client.ts` + `types.ts` como en Fase 0):
- **`schemas.ts` separado de `mapper.ts`**: separar "¿esto tiene la forma que espero?" de "¿cómo lo transformo?" permite detectar cambios de contrato de Workera con un error claro, en vez de que un `undefined` se propague silenciosamente hasta una tarjeta del dashboard o, peor, hasta el Excel de remuneraciones.
- **`errors.ts` separado**: un timeout, un 401 y un 429 de Workera deben convertirse en tipos de error que el resto de la app pueda manejar de forma distinta (reintento vs. alerta al admin vs. bloqueo de sincronización), sin que cada caller tenga que conocer los detalles HTTP de Workera.
- **`raw-types.ts` vacío por ahora**: se llena recién cuando tengamos ejemplos reales de response. No se debe inferir su contenido.

Regla de import: solo `src/app/api/**` (Route Handlers) puede importar `src/lib/workera/client.ts`. Nada bajo `src/components` o cualquier `"use client"` debe importar nada de esta carpeta.

---

## 5. Checklist de documentación a conseguir de Workera

Antes de escribir `httpClient.ts`, `schemas.ts` o cualquier migración de Fase 2, necesitamos confirmar:

**Acceso y autenticación**
- [ ] Documentación oficial (Swagger/OpenAPI o equivalente)
- [ ] Base URL(s) (prod, sandbox si existe)
- [ ] Mecanismo de autenticación (API key, OAuth2, token por request) y cómo se renueva
- [ ] Rate limits (requests/minuto, políticas de backoff)
- [ ] Formato y estructura de errores de la API

**Entidades y campos**
- [ ] Endpoint y payload de ejemplo: listado de empleados, con su ID estable
- [ ] ¿RUT u otro identificador está disponible? ¿En qué endpoint?
- [ ] Empresa, sucursal, centro de costo, área/departamento, cargo — ¿existen como campos o hay que inferirlos?
- [ ] Relación empleado↔supervisor/jefatura: ¿existe un campo directo? (crítico, ver sección 6)
- [ ] Jornada/turno asignado — endpoint y ejemplo de payload
- [ ] Marcaciones (entrada/salida) — endpoint, ejemplo, y si distingue "marcación cruda" de "asistencia procesada"
- [ ] Horas trabajadas — ¿las calcula Workera o solo entrega marcaciones crudas?
- [ ] Horas extra — ¿Workera las detecta/calcula, o es puramente derivado de jornada vs. marcación?
- [ ] Horas extra ya autorizadas dentro de Workera (si existe un flujo propio)
- [ ] Licencias médicas — endpoint, campos disponibles (evitar pedir diagnóstico, ver sección 9)
- [ ] Vacaciones — endpoint, fechas de inicio/fin, estado (solicitada/aprobada)
- [ ] Permisos/otras ausencias — vocabulario de tipos que usa Workera
- [ ] Estados de empleado (activo, con licencia, de vacaciones, etc.) y si son mutuamente excluyentes

**Escritura**
- [ ] ¿Existe endpoint para autorizar/rechazar horas extra desde fuera de Workera?
- [ ] Si existe, ¿qué payload espera y qué confirma en la respuesta?
- [ ] ¿Hay control de concurrencia (alguien más pudo haber modificado el registro en Workera)?

**Operación**
- [ ] Paginación (cursor, offset, tamaño máximo de página)
- [ ] Filtros por fecha (rango soportado, granularidad, timezone de los parámetros)
- [ ] Timezone en que Workera entrega y espera fechas/horas
- [ ] ¿Existen webhooks, o es solo polling?
- [ ] ¿Los registros pueden modificarse después de creados? ¿Hay `updated_at` o similar para detectar cambios?

**Mientras esto no esté confirmado, `src/lib/workera/raw-types.ts`, `schemas.ts` y `httpClient.ts` no se implementan** — se sigue trabajando con `mockClient.ts` cuando llegue Fase 4.

---

## 6. Análisis: relación supervisor → trabajadores

Este es el punto de mayor riesgo para el diseño de RLS en Fase 3, así que vale la pena decidirlo con cuidado ahora, aunque no implementemos nada todavía.

### Opción A — Workera es la fuente de verdad de supervisor↔trabajador

**Pros:**
- Una sola fuente de verdad, sin duplicar mantenimiento de organigrama.
- Cambios de supervisor en Workera (traslados, reestructuraciones) se reflejan automáticamente.

**Contras:**
- Dependemos de que Workera efectivamente exponga este campo con la granularidad correcta (¿jefatura directa? ¿por centro de costo? ¿múltiples supervisores por trabajador?).
- Si Workera no lo expone, o lo expone de forma distinta a como necesitamos operar (ej. por área en vez de por persona), quedamos bloqueados hasta que Workera lo soporte.
- Un error o retraso de sincronización en Workera puede dejar a un supervisor sin ver a su equipo, o viendo el equipo de otro, el mismo día que necesita aprobar horas extra.

### Opción B — Nuestra base de datos mantiene `employee_supervisors` de forma interna

**Pros:**
- Control total: el admin puede corregir una asignación incorrecta sin depender de que alguien la arregle en Workera.
- Permite casos que Workera quizás no modele bien (supervisor temporal, cobertura de vacaciones, un trabajador con dos supervisores por proyecto).
- Es la opción resiliente si Workera no expone esta relación en absoluto, o la expone incompleta.

**Contras:**
- Requiere mantenimiento manual inicial y sincronización de altas/bajas de trabajadores.
- Puede desincronizarse de la realidad organizacional si nadie actualiza la tabla cuando cambia un supervisor.

### Recomendación

**Opción B como fuente de verdad operativa, con Workera como sugerencia/semilla si expone el campo.**

Es decir: si Workera entrega `employee.supervisor_id` (o equivalente), lo usamos para **poblar automáticamente** `employee_supervisors` en la sincronización (útil como valor por defecto y para detectar altas nuevas), pero el admin puede **sobreescribir** esa asignación manualmente en nuestra base, y esa sobreescritura no se pierde en la siguiente sincronización. Esto evita quedar bloqueados por las limitaciones de Workera y evita también un trabajo manual completo desde cero si Workera sí expone algo útil.

Esta relación es además la pieza central de RLS en Fase 3 (un supervisor solo lee filas de empleados presentes en `employee_supervisors` para su propio `user_id`), así que su diseño exacto se retoma en Fase 2 con este criterio ya decidido.

---

## 7. Matriz de source of truth (revisada)

| Categoría | Fuente de verdad | Nota |
|---|---|---|
| Datos maestros del empleado (nombre, RUT, cargo, sucursal) | Workera | Se sincroniza, no se edita manualmente salvo excepción justificada y auditada |
| Supervisor↔trabajador | **Nuestra base**, sembrada desde Workera si está disponible | Ver sección 6 — decisión clave, distinta al esquema conceptual original del usuario |
| Marcaciones / asistencia cruda | Workera | No se recalcula ni se corrige localmente |
| Horas trabajadas / horas extra *detectadas* | Workera, **si Workera las calcula**; si no, se derivan en nuestro backend a partir de marcación + jornada, y quedan explícitamente marcadas como "calculado localmente" | Pendiente de confirmar con documentación (checklist sección 5) |
| Licencias / vacaciones / permisos | Workera | Nosotros solo reflejamos estado, no gestionamos el trámite |
| Aprobación/rechazo de horas extra por el supervisor | **Nuestra aplicación** | Es el objeto central del sistema, con auditoría propia |
| Autorización definitiva hacia nómina | Workera, **si su API permite escritura** (Fase 8); si no, nuestra aprobación queda como el registro definitivo para el Excel | Condicional, a confirmar |
| Auditoría de acciones (quién aprobó, cuándo, qué cambió) | **Nuestra base**, siempre | Workera no tiene por qué saber quién aprobó en nuestra UI |
| Excel semanal | Generado por nosotros, combinando datos importados de Workera + decisiones propias | No es fuente de verdad, es un artefacto de salida |

Diferencia principal respecto al esquema conceptual que planteaste originalmente: **supervisor↔trabajador se mueve de "Workera" a "nuestra base"** por lo expuesto en la sección 6, y "horas extra calculadas" queda condicional a confirmar si Workera realmente las calcula o si es responsabilidad nuestra derivarlas.

---

## 8. Estrategia de sincronización e idempotencia (diseño, no implementación)

Principios para Fase 2/5, sin escribir migraciones todavía:

- **Cada entidad sincronizada guarda su `external_id` de Workera** como columna con `UNIQUE` (futura constraint), nunca como parte de una clave compuesta frágil. Si Workera no da un ID de registro individual para asistencia/horas extra (solo empleado + fecha), la clave de upsert futura sería `(employee_external_id, date)` — a confirmar en checklist sección 5.
- **Toda escritura de sincronización es un upsert**, nunca un insert ciego: `insert ... on conflict (external_id) do update`. Esto responde directamente a "duplicados" y "reimportar el mismo día dos veces".
- **Nunca sobrescribir una aprobación humana con datos de sincronización.** La revisión del supervisor (`overtime_reviews` o equivalente) vive en una tabla separada de los datos crudos importados (`attendance_records`, `overtime_records`); un re-sync actualiza los datos crudos pero no toca la fila de revisión ya existente. Si el dato crudo cambió *después* de que un supervisor ya aprobó, eso se marca como una alerta ("Workera modificó un registro ya revisado"), no como una sobreescritura silenciosa.
- **`workera_sync_runs`** (ya prevista en el esquema conceptual original) registra cada corrida: fecha objetivo, timestamp de inicio/fin, cantidad de registros procesados, errores, y opcionalmente el rango de fechas solicitado. Sirve tanto para debugging como para no volver a lanzar dos sync runs simultáneos sobre el mismo día (lock lógico).
- **Payload crudo opcional**: guardar el JSON crudo recibido de Workera (en una columna `jsonb` o tabla de staging) para el registro del día, útil para auditar discrepancias futuras sin tener que volver a pedirle el dato a Workera (que podría haber cambiado). A decidir en Fase 2 si esto vive en la misma tabla o en una tabla de staging separada — probablemente separada, para no inflar las tablas operativas.
- **Detección de cambios**: si Workera no expone un `updated_at` confiable por registro (checklist sección 5), un hash del payload relevante (ej. `md5` de los campos que nos importan) permite detectar "esto cambió desde la última sync" sin depender de que Workera lo declare explícitamente.
- **Idempotencia de la corrida completa**: correr la sincronización del mismo día dos veces debe dar el mismo resultado final (no duplicar filas, no duplicar horas extra). Esto se logra naturalmente si todo el punto anterior (upsert por `external_id`) se respeta.

---

## 9. Estrategia de timezone

- **Postgres**: todas las columnas de instante (marcación, timestamps de aprobación, `created_at`/`updated_at`) se guardan como `timestamptz` (con offset), nunca `timestamp` sin zona. Esto es una decisión de tipo de columna a aplicar en Fase 2, no negociable.
- **Fechas "lógicas" (el día que se está revisando)** se tratan distinto de instantes: "el turno del 16/08" es una fecha de calendario en `America/Santiago`, no un instante. Estas se guardan como `date` (sin hora), y la conversión "¿qué instante UTC corresponde al inicio/fin de ese día en Santiago?" se hace explícitamente en el backend, nunca asumiendo el timezone del navegador del supervisor.
- **"Traer registros de ayer"**: el cálculo de qué es "ayer" se hace en el servidor (Route Handler / cron job) usando `America/Santiago` explícitamente (ej. con una librería como `date-fns-tz` o funciones nativas de `Intl` con timezone fijo), no con `new Date()` del entorno de ejecución, que en Vercel corre en UTC. Esto es crítico: si se calcula "ayer" con la hora UTC del servidor sin convertir, en ciertas horas del día se obtendría la fecha equivocada.
- **Horario de verano**: Chile ha tenido cambios de política de horario de verano en años recientes (a veces sí, a veces no lo aplica). No hay que hardcodear un offset fijo (`UTC-3` o `UTC-4`); siempre usar el identificador de zona `America/Santiago` y dejar que la librería de timezone resuelva el offset vigente para esa fecha específica.
- **Parámetros hacia Workera**: si al pedir "registros del día X" Workera espera fechas en un timezone distinto (a confirmar en checklist sección 5), la conversión también se hace explícitamente en `src/lib/workera/httpClient.ts`, documentando el supuesto.

---

## 10. Riesgos de privacidad y seguridad — clasificación de datos sensibles

| Dato | Sensibilidad | Tratamiento |
|---|---|---|
| RUT / identificador de persona | Alta (dato personal identificable) | Acceso restringido por RLS; nunca en logs ni en URLs |
| Licencia médica (el hecho de tenerla, fechas) | Alta (dato de salud) | Se almacena **solo el estado y las fechas**, nunca diagnóstico ni motivo médico — principio de minimización explícito, tal como pediste |
| Vacaciones / permisos | Media | Igual criterio: fechas y tipo, sin justificación detallada salvo que el supervisor la escriba voluntariamente como observación (y en ese caso, tratarla como dato sensible también) |
| Horarios / marcaciones | Media | Relevante para remuneraciones; acceso limitado a supervisor del equipo + admin |
| Historial laboral (cambios de cargo, sucursal) | Media | Solo si Workera lo expone; no se infiere ni se reconstruye |
| Aprobaciones/rechazos y quién los hizo | Media (dato del supervisor, no del trabajador) | Es el corazón de la auditoría; se conserva indefinidamente salvo política de retención que definamos |
| Observaciones libres del supervisor | **Variable — riesgo alto si se usa mal** | Es texto libre: un supervisor podría escribir accidentalmente algo sensible (ej. mencionar un diagnóstico). Recomendación: agregar una nota visible en la UI (Fase 7) del tipo "no incluyas información médica o diagnósticos en las observaciones" |

**Principio de minimización aplicado desde ya:** el modelo conceptual de la sección 3 (`AbsenceRecord`) **no incluye ningún campo de diagnóstico o motivo médico** — solo `type`, `startDate`, `endDate` y el ID externo. Si Workera expone un campo de motivo/diagnóstico, la recomendación es **no sincronizarlo** a nuestra base salvo que exista una razón operativa concreta y aprobada explícitamente, no simplemente "porque Workera lo manda".

**Otros riesgos a tener en cuenta para Fase 3 (RLS) y Fase 11 (administración):**
- Un admin viendo "todo" implica que la cuenta de admin es especialmente sensible — recomendable 2FA obligatorio en Supabase Auth para rol admin (a definir en Fase 3).
- El Excel semanal exportado contendrá datos sensibles (RUT, licencias) en un archivo descargable — su distribución posterior queda fuera del control del sistema una vez descargado; vale la pena, en Fase 10/11, dejar registrado quién generó/descargó cada export (`excel_exports`, ya previsto en el esquema conceptual original).

---

## Recomendación final: ¿estamos listos para Fase 2?

**No todavía — y eso es correcto en esta etapa.**

Podemos y debemos avanzar con:
- El modelo interno conceptual (sección 3) como guía de diseño.
- La estrategia de idempotencia/sincronización (sección 8) y timezone (sección 9) como decisiones ya tomadas.
- La decisión sobre supervisor↔trabajador (sección 6, Opción B) como base para el diseño de RLS.

Pero **el esquema definitivo de Postgres no debería escribirse hasta confirmar, como mínimo**:
1. Si Workera calcula horas extra o si las derivamos nosotros (cambia si `overtime_records` es una tabla de datos importados o una tabla calculada).
2. Si existe `employee.supervisor_id` o equivalente en Workera (afecta si `employee_supervisors` tiene una columna `source` y lógica de reconciliación, o es puramente manual).
3. Qué IDs externos están disponibles por entidad (empleado, marcación, horas extra, ausencia) — de esto depende directamente qué columnas son `UNIQUE` y qué estrategia de upsert usamos.
4. El timezone en que Workera entrega/espera fechas.

**Siguiente paso sugerido:** conseguir las respuestas del checklist de la sección 5 (aunque sea parcialmente — no hace falta el 100%) antes de iniciar Fase 2. Si hay partes de Workera que tardarán en confirmarse, podemos diseñar Fase 2 con los campos confirmados y dejar explícitamente como "pendiente de confirmación" los que dependen de la API real, en vez de bloquear todo el proyecto.

---

**No se creó ningún esquema, tabla ni migración.** Este documento queda en `docs/PRE_FASE2_WORKERA_VALIDATION.md` como insumo para Fase 2 cuando la apruebes.
