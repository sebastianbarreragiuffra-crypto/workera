# Reglas de negocio y modelo de dominio — pre-Fase 2

Estado: cierre de dominio funcional, previo al diseño de esquema. **No contiene DDL, migraciones, UI ni integración con Workera.** Se apoya en `docs/PRE_FASE2_WORKERA_VALIDATION.md` y `docs/EXCEL_WORKFLOW_ANALYSIS.md`; no repite lo ya decidido allí salvo para actualizarlo.

---

## 1. Modelo del dominio: hecho → cálculo → decisión → resultado

Regla no negociable para todo el dominio, no solo para horas extra:

```
HECHO ORIGINAL (Workera / reloj control)
        ↓  nunca se edita in situ; si cambia, se versiona (sección 10 de este doc)
INTERPRETACIÓN / CÁLCULO (¿quién calcula: Workera o nosotros? — por tipo, ver sección 9)
        ↓  es un dato derivado, no una decisión
DECISIÓN HUMANA (supervisor/admin, con cantidades explícitas, no solo un booleano)
        ↓  siempre con actor + timestamp + motivo; nunca sobrescribe la decisión anterior sin dejar rastro
RESULTADO PARA REMUNERACIONES (lo que efectivamente entra al Excel semanal cerrado)
```

Estas cuatro capas **nunca se colapsan en un único campo**. Esto ya estaba parcialmente decidido en los documentos anteriores; aquí se convierte en regla explícita aplicada a **todas** las categorías del Excel real (horas extra, atrasos, ausencias), no solo a horas extra.

---

## 2 y 3. Horas extra: HH 50% / HH 100% y aprobación parcial

**Una misma jornada puede tener ambos tipos simultáneamente** (ej. 2h al 50% + 1h al 100% el mismo día) — el Excel real ya lo sugiere con dos filas separadas por trabajador. El modelo no puede representar esto como dos columnas fijas (`hh50_minutes`, `hh100_minutes`) en una sola fila de "horas extra del día", porque:
- Si en el futuro aparece una tercera tasa (ej. feriado irrenunciable, normativa distinta), habría que alterar la estructura de la tabla en vez de agregar un valor a un catálogo.
- Cada tasa tiene su propio ciclo de detectado→decidido, y mezclarlas en columnas paralelas duplicaría toda la lógica de aprobación parcial dos veces.

**Decisión:** `OvertimeRecord` representa **una franja de horas extra de un tipo específico**, no "las horas extra del día". Un día puede tener cero, uno o varios `OvertimeRecord` (uno por tasa/tipo detectado ese día). El "tipo" (`OVERTIME_50`, `OVERTIME_100`, y lo que se agregue después) es un valor de un catálogo controlado, no una columna. Esto es exactamente lo que evita el "hack" que pedías prevenir.

**Aprobación parcial (obligatoria, no opcional):** cada `OvertimeRecord` tiene un `OvertimeDecision` asociado con **cantidades**, nunca un booleano:

```
OvertimeRecord.detected_minutes        = 120   (2h) — hecho/cálculo, inmutable una vez fijado
OvertimeDecision.approved_minutes      = 90    (1h30) — decisión humana
OvertimeDecision.rejected_minutes      = 30    (derivado: detected − approved, pero se persiste
                                                 para que una consulta no dependa de recalcular)
OvertimeDecision.status                = 'partially_approved' | 'fully_approved' |
                                          'rejected' | 'pending'  (derivado de las cantidades,
                                          persistido para poder filtrar/indexar sin recalcular)
```

`approved_minutes` nunca puede exceder `detected_minutes` — esto es una validación `BLOCKING` ya identificada en `EXCEL_WORKFLOW_ANALYSIS.md` sección 6, y aquí queda confirmada como una restricción de integridad del dominio, no solo una alerta de UI.

---

## 4. Estado del trabajador por fecha

Estados conceptuales (nombres no definitivos, catálogo controlado, no un enum fijo en código de aplicación — ver sección 10):

`PRESENT`, `ABSENT`, `VACATION`, `MEDICAL_LEAVE`, `WORK_ACCIDENT_LEAVE`, `PERMISSION`, `DAY_OFF`, `HOLIDAY`, `UNKNOWN`, `NEEDS_REVIEW`.

**`MEDICAL_LEAVE` (licencia médica común) y `WORK_ACCIDENT_LEAVE` (licencia mutual) se modelan como tipos distintos, no como una subcategoría del mismo tipo.** Motivo: en Chile tienen tratamiento legal y de pago distinto (licencia común se tramita vía Isapre/Fonasa con subsidio; licencia/accidente mutual lo cubre el organismo administrador de la Ley 16.744, con reglas de reposo y reincorporación distintas). Aunque hoy no sabemos si esto afecta el cálculo de remuneraciones dentro de nuestra app (pregunta **P0**, sección 15), separar el tipo desde el modelo no cuesta nada estructuralmente y evita una migración posterior si la respuesta es "sí, se tratan distinto".

**Minimización de datos (ya establecida en `PRE_FASE2_WORKERA_VALIDATION.md` sección 9, reafirmada aquí):** el estado de un `AbsenceRecord` guarda **tipo + fechas + referencia externa**, nunca diagnóstico, nunca motivo médico detallado. Si Workera expusiera un campo de diagnóstico, no se sincroniza a nuestra base.

`NEEDS_REVIEW` no es un estado que Workera entregue — es un estado que **nuestro sistema asigna** cuando hay ambigüedad (ver máquina de estados, sección 11).

---

## 5. Correcciones manuales — reemplazo estructurado de los comentarios de Excel

Patrón conceptual, aplicado consistentemente donde el Excel real usa comentarios narrativos hoy (asistencia, principalmente marcaciones faltantes/corregidas):

```
original_value       — el dato tal como llegó de Workera/reloj control, nunca se borra
corrected_value       — el valor que el supervisor/admin determina correcto
correction_reason     — texto, obligatorio (reemplaza el comentario libre de hoy)
corrected_by          — quién
corrected_at          — cuándo
```

Ejemplo real equivalente al de un comentario del Excel (`"Berrios no marco salida el 22-10 salida a las 18:30"`):

```
AttendanceRecord.check_out_original = null (no marcó)
AttendanceCorrection.corrected_value = 18:30
AttendanceCorrection.correction_reason = "No marcó salida, confirmado por supervisor"
AttendanceCorrection.corrected_by = <usuario>
```

El valor original (`null`, en este caso "no marcó") **queda registrado como tal**, no se pierde reemplazándolo directamente en `AttendanceRecord`.

**Decisión de diseño (ver también sección 10):** este patrón se implementa como **tabla específica por tipo de hecho corregible** (`AttendanceCorrection`), no como una tabla polimórfica genérica de "correcciones" — mismo razonamiento que para las decisiones: cada tipo de hecho corregible tiene columnas propias (una corrección de marcación tiene `check_in`/`check_out`; una eventual corrección de tipo de ausencia tendría otras columnas), y una tabla genérica forzaría columnas nulas o un payload JSONB que pierde validación a nivel de base de datos.

---

## 6. "Se descuenta / no se descuenta" — dónde vive esta decisión

Analizadas las tres opciones planteadas:

**A. Parte de `DailyReview`** — descartada. `DailyReview` es un agregado del estado de revisión del día completo; convertirla en el lugar donde vive la decisión de descuento la sobrecargaría con un campo que en realidad depende de un hecho específico (un atraso, una marcación corregida), no del día como unidad. Además, un día puede tener más de una decisión de descuento (ej. un atraso Y una marcación corregida el mismo día), y `DailyReview` es 1:1 con el día — no puede representar varias sin volver a caer en el problema de columnas fijas de la sección 2.

**B. Entidad separada y genérica (`PayrollAdjustmentDecision`)** — descartada como entidad independiente, por la misma razón que se descartó una tabla `Decision` genérica en la sección 10: sin una referencia fuertemente tipada al hecho que origina el descuento, se vuelve una tabla polimórfica difícil de validar e indexar bien en Postgres.

**C. Decisión asociada directamente al hecho que la origina — recomendado.** El análisis del Excel real (`EXCEL_WORKFLOW_ANALYSIS.md` sección 2) muestra que "se descuenta o no" casi siempre está atado a un **atraso** o a una **marcación corregida**, no a la jornada como concepto abstracto. Por lo tanto:

- `LateArrivalDecision` incluye un campo de efecto en remuneración: `payroll_effect: DEDUCT | DO_NOT_DEDUCT | NEEDS_REVIEW` (ver sección 7).
- `AttendanceCorrection` puede, cuando corresponda, incluir el mismo tipo de campo si la corrección de marcación tiene implicancia de descuento (ej. una salida anticipada corregida y confirmada como injustificada).
- No se crea una entidad nueva. El concepto "decisión de descuento" es un **atributo del dominio**, aplicado en el lugar donde ya existe una decisión humana con contexto suficiente para tomarla — evita duplicar el patrón decisión (actor, timestamp, motivo) en una tercera tabla paralela.

---

## 7. Atrasos

Mismo principio que horas extra, con sus propias entidades (no reutiliza `OvertimeRecord`/`OvertimeDecision` porque la semántica de cantidades es distinta — un atraso no se "aprueba parcialmente" en minutos de trabajo extra, se **justifica o no** y eso determina cuánto es descontable):

```
LateArrivalRecord.detected_minutes     = 20   — hecho/cálculo (marcación real vs. horario asignado)
LateArrivalDecision.justified_minutes  = 20   — cuánto de eso se considera justificado
LateArrivalDecision.deductible_minutes = 0    — lo que efectivamente afecta remuneración (derivado,
                                                 persistido igual que en OvertimeDecision)
LateArrivalDecision.payroll_effect     = DO_NOT_DEDUCT
LateArrivalDecision.reason             = "Cita médica, boleta adjunta" (texto — reemplaza el
                                          comentario libre real del Excel)
```

Este es el mismo caso que tu ejemplo (`Workera: 20 min → Supervisor: justificado → Resultado: 0 min descontables`), confirmado 1:1 contra la evidencia real del Excel (comentarios de citas médicas, tránsito, etc. justificando atrasos).

---

## 8. Viáticos — fuera de alcance, sin cerrar la puerta

Clasificación: **`OUT_OF_SCOPE_PENDING_CONFIRMATION`**. No se modela ninguna entidad para viáticos en esta etapa ni en Fase 2.

Para no bloquear una futura incorporación sin rediseñar la arquitectura: el patrón hecho→cálculo→decisión→resultado y la estructura de "una entidad de registro + una entidad de decisión, referenciadas por `employee_id`+`date`" es genérico. Si más adelante se confirma que Viáticos entra al alcance, seguiría el mismo molde (`PerDiemRecord` + eventualmente una decisión si también requiere aprobación) sin tocar `Employee`, `DailyReview` ni el resto del modelo. No se reserva ninguna columna ni tabla vacía para esto ahora — extenderlo después es aditivo, no una migración destructiva.

---

## 9. Matriz de fuente de verdad (actualizada)

| Categoría | Fuente de verdad | Nota |
|---|---|---|
| Empleado | Workera | Sin cambios respecto al documento anterior |
| Supervisor↔trabajador | Nuestra base (sembrada desde Workera si está disponible) | Sin cambios — decisión ya tomada |
| Marcaciones | Workera | Sin cambios |
| Vacaciones | Workera, si disponible | Sin cambios |
| Licencias (común y mutual) | Workera, si disponible | **Confirmado por el Excel real que deben distinguirse como tipos separados** (sección 4) |
| Horas extra detectadas (minutos brutos) | Workera o cálculo interno | **Por confirmar (P0)** — ver sección 15 |
| HH 50% / HH 100% (clasificación por tasa) | **Por confirmar (P0)** | El Excel real las muestra ya clasificadas, pero no sabemos si Workera entrega la tasa o si se deriva de una regla nuestra (ej. día de semana vs. fin de semana/feriado) |
| Atrasos detectados | Workera o cálculo interno | **Por confirmar (P0)** — mismo caso que horas extra |
| Aprobación de horas extra (cantidades) | Supervisor | Sin cambios |
| Justificación de atrasos | Supervisor/Admin | Nuevo, confirmado por esta etapa |
| Descuento/no descuento | Supervisor/Admin, atado al hecho que lo origina | Nuevo, ver sección 6 |
| Correcciones de marcación | Supervisor/Admin | Nuevo, ver sección 5 |
| Auditoría | Nuestra aplicación | Sin cambios |
| Excel final | Nuestra aplicación, generado solo desde una semana `CLOSED` | Reforzado en sección 14 |

---

## 10. Modelo conceptual de entidades — decisión arquitectónica

### `Decision` genérica vs. entidades específicas

**Recomendación: entidades específicas por tipo de hecho (`OvertimeDecision`, `AbsenceDecision`, `LateArrivalDecision`), no una tabla `Decision` polimórfica genérica.**

Razonamiento:
- Cada decisión tiene **cantidades y campos propios con semántica distinta** (`approved_minutes`/`rejected_minutes` por tasa en horas extra; `justified_minutes`/`deductible_minutes` en atrasos; para ausencias, más que una cantidad, lo que se decide es confirmar o reclasificar un tipo). Una tabla genérica obligaría a columnas nulas la mayoría del tiempo, o a un `payload jsonb`, perdiendo las validaciones de integridad a nivel de base de datos (ej. `CHECK (approved_minutes <= detected_minutes)` deja de ser posible con un payload genérico).
- Postgres no tiene una forma ergonómica de "herencia de tabla" ampliamente recomendada para este caso (`table inheritance` de Postgres existe pero no es la práctica estándar recomendada para este tipo de modelo transaccional).
- Lo que sí conviene mantener **consistente por convención** (no por tabla compartida) entre las tres: nombres de columna comunes (`decided_by`, `decided_at`, `status`, `reason`), para que el código de aplicación y las políticas RLS se escriban de forma uniforme aunque las tablas sean distintas.
- Lo verdaderamente transversal (qué pasó, quién, cuándo, en qué entidad) **sí se centraliza — en `AuditLog`**, que es la pieza genérica correcta: un log de eventos no necesita las columnas específicas del dominio, solo referenciar qué cambió.

Mismo razonamiento aplicado a `AttendanceCorrection`: no se generaliza a una tabla `Correction` polimórfica por la misma razón.

### Lista de entidades (revisada)

| Entidad | Rol |
|---|---|
| `Employee` | Datos maestros del trabajador (Workera) |
| `SupervisorAssignment` | Relación supervisor↔trabajador (nuestra base, sembrada desde Workera si aplica) |
| `AttendanceRecord` | Hecho crudo de marcación/asistencia del día (Workera) |
| `AttendanceCorrection` | Corrección estructurada sobre un `AttendanceRecord` (sección 5) |
| `OvertimeRecord` | Hecho/cálculo de horas extra **por tipo de tasa** (sección 2) |
| `OvertimeDecision` | Decisión de aprobación (con cantidades) sobre un `OvertimeRecord` |
| `AbsenceRecord` | Hecho de vacaciones/licencia (común/mutual)/permiso/falta, con tipo explícito (sección 4) |
| `AbsenceDecision` | Confirmación o reclasificación de un `AbsenceRecord` cuando hay ambigüedad (ej. Workera marcó "falta" pero corresponde "permiso") |
| `LateArrivalRecord` | Hecho/cálculo de atraso (sección 7) |
| `LateArrivalDecision` | Justificación y efecto en remuneración de un atraso, incluye `payroll_effect` (secciones 6 y 7) |
| `DailyReview` | Estado de revisión agregado del trabajador para un día (máquina de estados, sección 11) |
| `WeeklyReview` | Estado de cierre del período (máquina de estados, sección 13) |
| `AuditLog` | Registro genérico transversal de toda acción relevante |
| `SyncRun` | Registro de cada corrida de sincronización con Workera |
| `ExcelExport` | Registro del artefacto Excel generado (ya definido en `PRE_FASE2_WORKERA_VALIDATION.md` sección 9, sin cambios) |

No se agrega `PayrollAdjustmentDecision` (ver sección 6). No se agrega ninguna entidad para Viáticos (ver sección 8). Esta lista es una **evaluación**, no una aceptación automática de la lista original del encargo — se mantiene casi idéntica porque, tras el análisis, resultó ser la estructura correcta; el cambio real está en cómo se resuelve el punto de la decisión genérica y el descuento, no en qué tablas existen.

---

## 11. Máquina de estados de `DailyReview`

```
IMPORTED
   │  (sync run crea/actualiza los hechos crudos del día; nadie lo ha revisado aún)
   ▼
PENDING_REVIEW
   │  (existe al menos un hecho que requiere decisión humana — horas extra, atraso,
   │   ausencia ambigua — o el supervisor debe confirmar explícitamente "sin novedad",
   │   correspondiente al botón "Sin horas extra" ya previsto en los requisitos originales)
   ▼
REVIEWED
   │  (todas las decisiones requeridas del día están tomadas y son consistentes)
   ▼
READY_FOR_WEEKLY_CLOSE
```

**Casos excepcionales (no lineales, se puede entrar a ellos desde cualquier estado posterior a `IMPORTED`):**

- **`NEEDS_REVIEW`** — se asigna cuando una validación `BLOCKING` (`EXCEL_WORKFLOW_ANALYSIS.md` sección 6) falla: horas extra sin decisión, licencia + horas trabajadas el mismo día, aprobado > detectado, etc. Un día en `NEEDS_REVIEW` no puede avanzar a `READY_FOR_WEEKLY_CLOSE` sin que un humano lo resuelva explícitamente.
- **`SYNC_CONFLICT`** — caso específico de `NEEDS_REVIEW` (ver sección 12), se distingue porque su origen es un **cambio externo de Workera después de una decisión ya tomada**, no un error de datos detectado en importación. Se separa de `NEEDS_REVIEW` genérico porque su resolución es distinta: no se trata de "falta una decisión", sino de "hay que decidir de nuevo con información nueva, preservando la decisión anterior como historial".
- **`CORRECTED_AFTER_REVIEW`** — un día ya `REVIEWED` (o incluso `READY_FOR_WEEKLY_CLOSE`) donde un humano corrige una decisión ya tomada (no por conflicto de sincronización, sino por un error propio detectado después, ej. "aprobé mal, era 1h no 1h30"). Se distingue de `SYNC_CONFLICT` porque el origen es interno, y de `NEEDS_REVIEW` porque no significa "falta decidir" sino "ya se decidió, y se volvió a decidir, y eso queda auditado". Después de resolverse, vuelve a `REVIEWED`.

**Regla de cierre semanal:** `WeeklyReview` no puede pasar a `READY_TO_CLOSE` mientras exista al menos un `DailyReview` en `NEEDS_REVIEW` o `SYNC_CONFLICT` dentro del período. `CORRECTED_AFTER_REVIEW` no bloquea el cierre una vez que vuelve a `REVIEWED`.

---

## 12. Cambios posteriores desde Workera — detección de conflicto

Escenario del encargo (08:00 Workera informa 2h → 09:00 supervisor aprueba 2h → 14:00 Workera corrige a 1h30) resuelto así:

**Mecanismo de detección:**
- Cada hecho sincronizado (`OvertimeRecord`, `AttendanceRecord`, `AbsenceRecord`, `LateArrivalRecord`) guarda `external_id`, `source_hash` (hash de los campos relevantes para una decisión — ej. minutos detectados, no de campos irrelevantes como metadata de formato) y `source_updated_at` si Workera lo entrega (a confirmar, checklist de `PRE_FASE2_WORKERA_VALIDATION.md`).
- En cada `SyncRun`, se compara el hash/`updated_at` recién obtenido contra el guardado.

**Si cambió y NO existe decisión previa referenciándolo:** se actualiza el hecho de forma normal (upsert), sin conflicto — nadie tomó una decisión sobre el valor viejo todavía.

**Si cambió y SÍ existe una decisión previa (`OvertimeDecision`, `LateArrivalDecision`, etc.) referenciándolo:**
1. El hecho original **no se sobrescribe** — o bien queda una nueva versión del hecho vinculada al mismo `external_id` (versionado), o se guarda el nuevo valor en un campo separado (`superseded_value`) manteniendo el original intacto — decisión de implementación para Fase 2, pero el principio ("nunca sobrescribir en el lugar") queda cerrado aquí.
2. Se guarda el `snapshot` del payload crudo recibido (jsonb), tanto el que originó la decisión como el nuevo, para poder reconstruir exactamente qué vio el supervisor cuando decidió y qué llegó después.
3. El `DailyReview` correspondiente pasa a `SYNC_CONFLICT`.
4. La decisión original **no se borra ni se recalcula automáticamente** — queda visible como "la decisión que se tomó con el dato anterior", y se exige una nueva decisión humana que explícitamente la reemplace o la confirme, quedando ambas en el `AuditLog`.

---

## 13. Cierre semanal

Estados de `WeeklyReview`:

```
OPEN            — revisión en curso, cualquier DailyReview puede estar en cualquier estado
READY_TO_CLOSE  — todos los DailyReview del período están en READY_FOR_WEEKLY_CLOSE,
                   pero el cierre no ocurre automáticamente: es una acción explícita
                   (gate de confirmación humana, evita cierres accidentales)
CLOSED          — inmutable; cualquier intento de modificar una decisión ya incluida
                   exige pasar primero por REOPENED, nunca una edición directa
REOPENED        — desbloqueo explícito por un admin, en sí mismo auditado (quién, cuándo,
                   por qué); tras corregir, debe volver a pasar por READY_TO_CLOSE → CLOSED,
                   nunca saltar directo de vuelta a CLOSED sin ese paso
```

Esto responde directamente a "diferenciar datos diarios revisados de semana cerrada": `DailyReview.READY_FOR_WEEKLY_CLOSE` es una condición necesaria pero no suficiente — el cierre semanal es un acto separado y explícito sobre `WeeklyReview`.

---

## 14. Excel como snapshot de una semana cerrada

**Confirmado: `WeeklyReview CLOSED → snapshot → ExcelExport` es la arquitectura correcta**, y no una opción entre varias. Razón: dado que la sección 12 establece que Workera puede seguir enviando cambios después de que un supervisor ya decidió, generar el Excel desde datos "vivos" (no cerrados) crearía la posibilidad de que dos generaciones del mismo período produzcan números distintos sin que quede explicado por qué — inaceptable para un artefacto que alimenta remuneraciones.

El `snapshot` (ya previsto conceptualmente en `PRE_FASE2_WORKERA_VALIDATION.md` sección 9) debe ser suficiente para que, si la semana se reabre (`REOPENED`) y se vuelve a cerrar más adelante, el `ExcelExport` anterior siga siendo válido como registro histórico de "qué información exacta produjo este Excel" — no se regenera retroactivamente un export ya emitido; un reopen que cambia datos y vuelve a cerrar genera un **nuevo** `ExcelExport`, dejando el anterior intacto como historial.

---

## 15. Preguntas de negocio pendientes

### P0 — bloquean el diseño (deben resolverse antes de fijar el detalle de Fase 2, no antes de este documento)

| # | Pregunta | Por qué bloquea |
|---|---|---|
| 1 | ¿Qué determina si una hora extra es `HH 50%` o `HH 100%`? (¿día de semana vs. fin de semana/feriado, exceso sobre jornada, u otra regla?) | Determina si la tasa es un dato que entrega Workera o una regla de cálculo que debemos implementar nosotros — cambia dónde vive la lógica |
| 2 | ¿Workera calcula horas extra y atrasos, o solo entrega marcaciones crudas? | Determina si `OvertimeRecord`/`LateArrivalRecord` son datos importados tal cual o calculados por nuestro backend a partir de jornada + marcación |
| 3 | ¿Quién aprueba horas extra formalmente hoy — el supervisor directo de cada trabajador, o es RRHH quien centraliza la decisión (como sugiere que casi todos los comentarios del Excel real son de una sola persona)? | Determina el modelo de permisos/roles real, no solo el conceptual (admin/supervisor) |
| 4 | ¿Quién decide "se descuenta / no se descuenta" — el mismo actor que aprueba horas extra, u otro rol distinto? | Afecta permisos y RLS de `LateArrivalDecision`/`AttendanceCorrection` |
| 5 | Licencia médica común vs. mutual: ¿tienen reglas de pago o proceso distintas que la aplicación deba reflejar más allá de solo el tipo? | Si la respuesta agrega campos o flujos distintos, cambia el diseño de `AbsenceRecord`/`AbsenceDecision` |
| 6 | ¿Cuál es el ciclo real de pago/revisión — semanal como pide el objetivo del proyecto, o el período de ~6 semanas que muestra el Excel real? | Determina la granularidad de `WeeklyReview` (nombre y período pueden no coincidir con "semana" literal) |

### P1 — importantes antes de implementación, no bloquean el diseño conceptual

| # | Pregunta | Por qué no bloquea el diseño |
|---|---|---|
| 7 | ¿La aprobación parcial de horas extra es una práctica real frecuente, o una capacidad "por si acaso"? | El modelo ya la soporta estructuralmente (sección 3); esto solo afecta prioridad de UI en fases posteriores |
| 8 | ¿Existe una tabla de tolerancia oficial de atrasos, o es siempre caso a caso? | El modelo ya soporta ambos casos (`justified_minutes` puede ser una regla automática o una decisión manual); esto define reglas de negocio a implementar en Fase 7+, no la estructura |
| 9 | ¿Una semana cerrada puede reabrirse, y bajo qué condiciones? | El modelo ya prevé `REOPENED` (sección 13); esto define política de permisos, no estructura |
| 10 | ¿Quién puede corregir una aprobación ya incluida en una semana cerrada — solo admin, o también el supervisor original? | Afecta RLS de Fase 3, no el modelo de datos de Fase 2 |
| 11 | ¿Viáticos entra al alcance de esta aplicación en algún momento futuro? | Ya se dejó la puerta abierta sin comprometer el modelo actual (sección 8) |

### P2 — puede resolverse después, sin impacto estructural conocido

| # | Pregunta |
|---|---|
| 12 | Significado de los 7 colores de relleno usados en el Excel actual sin leyenda documentada |
| 13 | Por qué algunos trabajadores del Excel real tienen dos filas `HH 50%` + `TOTAL 50%` (posible inconsistencia de plantilla, no necesariamente una regla de negocio) |
| 14 | Vocabulario final exacto de los nombres de estado (los usados en este documento son conceptuales, confirmado explícitamente por el encargo que pueden cambiar) |

---

## 16. Impacto sobre Fase 2

Este documento no reemplaza `PRE_FASE2_WORKERA_VALIDATION.md` ni `EXCEL_WORKFLOW_ANALYSIS.md`, los completa:

- Confirma y detalla la separación `OvertimeRecord`/`OvertimeDecision` ya anticipada, y agrega el mismo patrón para atrasos (`LateArrivalRecord`/`LateArrivalDecision`).
- Resuelve la pregunta abierta de dónde vive "se descuenta o no" (sección 6): no es una entidad nueva, es un atributo de las decisiones ya existentes.
- Resuelve la pregunta arquitectónica de tabla genérica vs. específica para decisiones y correcciones (sección 10): específicas, con `AuditLog` como la pieza transversal.
- Formaliza la máquina de estados de `DailyReview` y `WeeklyReview` (secciones 11 y 13), que antes existía solo como intención ("revisar", "cerrar semana") sin estados explícitos.
- Cierra la estrategia de conflicto de sincronización (sección 12) con un mecanismo concreto (hash/`updated_at` + versionado + `SYNC_CONFLICT`), reemplazando la descripción más general de `PRE_FASE2_WORKERA_VALIDATION.md` sección 8.
