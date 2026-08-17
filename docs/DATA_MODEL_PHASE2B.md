# Modelo de datos — Fase 2B (extensión operativa)

Extiende `docs/DATA_MODEL_PHASE2.md` (Fase 2A, commit `0345850`) mediante **6 migraciones nuevas** (`08` a `13`), sin modificar ninguna de las 7 migraciones de Fase 2A. `docs/DATA_MODEL_PHASE2.md` no se toca ni se reemplaza — este documento es un complemento.

Migraciones de esta fase:

| Migración | Contenido |
|---|---|
| `08_employee_group_installation_and_history` | Seed `INSTALLATION` + `employee_group_assignments` |
| `09_attendance_statuses` | Catálogo `attendance_statuses` + `attendance_status_records` (11 códigos reales) |
| `10_late_arrival_justification_and_totals` | `justification_status` (columna generada) + vista `late_arrival_daily_totals` |
| `11_production_overtime_bonus` | `bonus_types`, `bonus_policies`, `employee_daily_bonuses` + trigger de validación |
| `12_reporting_periods` | `reporting_periods`, FK en `weekly_reviews`, `period_snapshots`, `excel_exports.export_scope` |
| `13_supporting_documents` | `supporting_documents` (metadata, sin binarios) |

---

## 1. Installation

Nuevo `employee_group` (`INSTALLATION`), sembrado como fila en el catálogo existente (`employee_groups`, Fase 2A) — no requirió ningún cambio de esquema, confirmando que el catálogo (en vez de un enum rígido) fue la decisión correcta desde Fase 2A. Los tres grupos vigentes: `PRODUCTION`, `INSTALLATION`, `ADMINISTRATION`.

---

## 2. Employee group history

`employees.employee_group_id` (Fase 2A) es un único valor sin vigencia — no alcanza para responder "¿a qué grupo pertenecía este trabajador en una fecha histórica?". Se agregó `employee_group_assignments`, con el **mismo patrón** ya usado en Fase 2A para `schedule_assignments`/`supervisor_assignments` (vigencia `effective_from`/`effective_to` + `EXCLUDE USING gist` anti-solapamiento), en vez de inventar un mecanismo nuevo.

`employees.employee_group_id` **no se elimina**: queda documentado como caché de conveniencia del "grupo actual", que la sincronización futura debe mantener alineado con la fila vigente (`effective_to IS NULL`) de `employee_group_assignments`. No se implementó un trigger de sincronización automática entre ambos — es responsabilidad de la capa de aplicación/sync (mismo criterio de "no sobreautomatizar" de la sección 48 del encargo).

---

## 3. Supervisor Installation

**No se agregó ninguna tabla ni columna nueva.** `supervisor_assignments` (Fase 2A) ya relaciona supervisor↔trabajador; "Supervisor Producción ve trabajadores de Producción" emerge de un `JOIN` con `employees.employee_group_id` (o `employee_group_assignments` para una fecha específica) — el grupo del trabajador ya está disponible sin duplicarlo en `supervisor_assignments`. Agregar `production_supervisor_id`/`installation_supervisor_id` a `Employee` habría sido exactamente el anti-patrón que el encargo pidió evitar, y se evitó.

---

## 4. Attendance statuses

`attendance_statuses`: catálogo (no enum), `id uuid` como PK técnica, `code` (P, F, F-P, ...) como clave de negocio única — "el código visual no debe ser necesariamente la PK técnica", satisfecho literalmente. `category` agrupa semánticamente (`PRESENT`/`ABSENCE`/`PERMISSION`/`VACATION`/`LEAVE`/`RECOVERY`/`MARKING_PROBLEM`) sin perder el código específico — el Excel mensual sigue pudiendo mostrar `F-J` y `F-P` por separado.

## 5. Los 11 códigos

Sembrados exactamente como los entregó el encargo (no inferidos):

| Código | Categoría | requires_review |
|---|---|---|
| P | PRESENT | false |
| F | ABSENCE | false |
| F-P | PERMISSION | false |
| F-J | ABSENCE | false |
| P-L | PERMISSION | false |
| P-M | PERMISSION | false |
| V | VACATION | false |
| L | LEAVE | false |
| L-M | LEAVE | false |
| R | RECOVERY | false |
| ? | MARKING_PROBLEM | **true** |

`F-P`/`F-J` comparten familia semántica en el encargo ("ABSENCE/PERMISSION") pero se asignó una categoría única a cada uno (decisión de diseño, no un dato confirmado): `F-P` → `PERMISSION` (el rasgo distintivo es que hay permiso), `F-J` → `ABSENCE` (sigue siendo falta, aunque justificada). Documentado explícitamente como juicio propio, no como confirmación de negocio.

`attendance_status_records`: hecho versionado e inmutable (mismo patrón `source_version`/`is_current`/trigger de inmutabilidad que `attendance_records`/`absence_records` de Fase 2A). **Por qué es una entidad separada de `absence_records` y `attendance_records`**: `P`, `R` y `?` no son ausencias en absoluto (presente, recuperan horas, problema de marcación) — no encajan en `absence_records`. Son tres hechos distintos del mismo día (marcación cruda, evento de ausencia por rango, código diario puntual), cada uno con su propio ciclo de vida y origen posible; forzarlos a una sola tabla habría mezclado conceptos con semánticas de versionado distintas.

---

## 6. Manual entries

`attendance_status_records.source` admite `workera`/`system`/`manual` (más amplio que `attendance_records.source`, que solo distingue `workera`/`manual` para la marcación cruda). Cuando `source = 'manual'`, `created_by` es **obligatorio** (`CHECK`) — trazabilidad de quién registró la novedad. `reason` documenta el motivo. `system` queda reservado para clasificaciones futuras que el propio backend infiera (no usado todavía en Fase 2B).

---

## 7. Vacaciones

Sin cambios estructurales en `absence_records` (Fase 2A) — ya tenía `source`/`external_id`/`source_hash`/`source_version`/`is_current`. Lo nuevo es que `V` también existe como código en `attendance_status_records` (el "renglón diario" que el Excel necesita mostrar), coexistiendo deliberadamente con el evento de rango en `absence_records` (ver sección 5). "Evitar duplicaciones cuando una entrada manual posteriormente aparezca en Workera" se resuelve con el mismo mecanismo de versionado + índice único parcial `is_current` — ver sección 22.

---

## 8. Licencias

`L`/`L-M` siguen siendo tipos separados en `absence_types` (Fase 2A) y ahora también como códigos individuales en `attendance_statuses`. La duración se sigue calculando por consulta (`end_date - start_date + 1`), **no** se agregó ninguna columna `duration_days`: se evaluó y se descartó incluso una columna `GENERATED ALWAYS AS` (que habría sido segura, sin riesgo de inconsistencia) porque no había ningún caso de uso identificado que lo requiriera más allá de una consulta trivial — agregar la columna habría sido superficie de esquema sin necesidad real (evitar sobreingeniería). El "status" de una licencia sigue viviendo en `absence_decisions.decision_status` (Fase 2A) — no se duplicó.

---

## 9. Supporting documents

`supporting_documents`: **se evaluó y se descartó explícitamente** una relación polimórfica genérica (`related_entity_type text` + `related_entity_id uuid`, sin FK real). Motivo: Postgres no puede validar que `related_entity_id` apunte a una fila existente de la tabla correcta, y una futura política de RLS no podría expresar "el supervisor de este trabajador puede leer este documento" con un `JOIN` directo sin saber en tiempo de diseño a qué tabla apunta.

En su lugar: tres columnas FK específicas y nullable (`absence_record_id`, `late_arrival_decision_id`, `attendance_status_record_id`), con `CHECK (num_nonnulls(...) <= 1)` — como máximo una relación puntual, o ninguna (documento asociado solo al trabajador). Cada FK tiene integridad referencial real. El costo (una columna nueva por cada tipo de hecho adjuntable futuro) se aceptó explícitamente dada la sensibilidad de estos documentos — prioridad de integridad sobre economía de columnas.

`document_type` es `text + CHECK` (`MEDICAL_CERTIFICATE`/`TRANSPORT_PROOF`/`IDENTIFICATION`/`OTHER`), no un catálogo aparte — conjunto pequeño y de bajo riesgo de crecer con frecuencia; si el negocio confirma que crecerá activamente, se recomienda revisarlo hacia un catálogo en una fase posterior.

---

## 10. Seguridad de documentos

Documentado, **no implementado**: `storage_path` apuntará a un bucket **privado** de Supabase Storage (no creado en esta fase). El acceso futuro debe ser vía *signed URLs* de corta duración + políticas de Storage/RLS — nunca URLs públicas permanentes. Ninguna columna de `supporting_documents` almacena diagnóstico, enfermedad ni detalle clínico — esa información, si existe, vive únicamente dentro del archivo privado, nunca en texto plano en Postgres (minimización de datos, mismo criterio que `absence_records` desde Fase 2A).

---

## 11. Late arrival justification

`late_arrival_decisions.justified` (booleano, Fase 2A) **no se eliminó ni se renombró** — se agregó `justification_status` como **columna generada** (`GENERATED ALWAYS AS (CASE WHEN justified THEN 'JUSTIFIED' ELSE 'NOT_JUSTIFIED' END) STORED`). Por qué esta alternativa y no un campo independiente: un campo independiente podría desincronizarse de `justified` (dos fuentes de verdad); una columna generada es imposible que quede inconsistente (Postgres la recalcula siempre, no admite escritura directa — confirmado por test), y no requiere modificar ningún `INSERT` existente de Fase 2A (los tests 005/007 originales siguen funcionando sin cambios).

`PENDING` **no es un valor almacenado**: sigue el mismo criterio ya usado para `OvertimeDecision`/`AbsenceDecision` — un `late_arrival_record` sin ninguna decisión asociada vigente **es** el "pendiente", por ausencia de fila. `reason` (Fase 2A) sigue cumpliendo el rol de comentario — no se duplicó ningún campo.

---

## 12. Weekly late totals

`late_arrival_daily_totals`: **vista**, no tabla ni columna mutable en `employees` (`employees.weekly_late_minutes` habría sido exactamente la fuente de verdad mutable que el encargo prohibió explícitamente). Expone, por trabajador+fecha, `detected_minutes` y (si existe decisión vigente) `payroll_minutes`. Los totales semanales/de período/mensuales se obtienen agregando esta vista por rango de fechas (`SUM` + `GROUP BY`) en la capa de reporting (fase futura) — no se materializa ningún acumulado, evitando tanto la inconsistencia con el detalle diario como la sobreingeniería de una tabla de agregados.

---

## 13. Bonus policy

`bonus_policies`: mismo patrón que `overtime_policies`/`late_arrival_policies` de Fase 2A — configurable por `employee_group_id` + vigencia, con `EXCLUDE USING gist` anti-solapamiento. `trigger_type` es un valor de catálogo (`CHECK`, hoy solo `APPROVED_OVERTIME_MINUTES_THRESHOLD`) en vez de un motor de reglas genérico en JSON — si aparece un segundo tipo de gatillo con parámetros distintos, se agrega como nueva columna nullable + nuevo valor permitido, el mismo patrón de crecimiento aditivo ya usado en `overtime_policies`.

`amount bigint` (nunca float) representa pesos CLP directamente (`1000 = $1.000 CLP`) — CLP no tiene subunidades en uso práctico, así que no se introdujo un concepto de "unidades menores" que ningún caso real pide hoy. `currency` fijo a `'CLP'` por ahora (`CHECK`).

**Sembrado:** única regla confirmada — `PRODUCTION` + `trigger_type = APPROVED_OVERTIME_MINUTES_THRESHOLD` + `threshold_minutes = 120` + `amount = 1000` + `currency = CLP`. **`INSTALLATION` NO tiene ninguna política sembrada** — confirmado por test (`011_bonus.sql` caso 6) — porque la regla está `PENDING_BUSINESS_CONFIRMATION` (sección 26 del encargo); ausencia de fila, no un valor inventado.

---

## 14. Daily bonus

`employee_daily_bonuses`: resultado **auditable**, no un flag booleano en `overtime_decisions`. Referencia una `overtime_decision_id` específica e inmutable (Fase 2A) — como esa fila nunca cambia tras insertarse, el bono queda con trazabilidad completa sin necesitar su propia cadena de versiones. `UNIQUE(overtime_decision_id)`: a lo sumo un bono por decisión de horas extra concreta (la elegibilidad es un hecho determinístico de esa decisión + esa política).

**No se generó automáticamente por trigger** (`approved_minutes = 120 → INSERT bonus` es explícitamente responsabilidad de una fase de cálculo futura, sección 48 del encargo). Lo que **sí** se implementó es un trigger de **validación** (`validate_employee_daily_bonus()`) que verifica, antes de aceptar un `INSERT`:
- que `employee_id`/`work_date` coincidan con los de la `overtime_decision` referenciada;
- que el `employee_group` de la política de bono coincida con el `employee_group` de la `overtime_policy` que originó la decisión de horas extra (mismo contexto de grupo, no solo el grupo *actual* del trabajador — evita inconsistencia si el trabajador cambió de grupo después);
- que la política esté vigente en `work_date`;
- que `approved_minutes >= threshold_minutes`;
- que `amount`/`currency` coincidan exactamente con los de la política (snapshot correcto).

Un bono aceptado es **completamente inmutable** (trigger `enforce_immutable_columns()` sin columnas mutables — ni siquiera `is_current`, porque no lo necesita: no hay noción de "reemplazar" un bono, un cambio posterior de Workera genera una nueva `overtime_decision` con su propio id, y por lo tanto un bono potencial completamente independiente, nunca una edición del anterior).

---

## 15. Money

`amount bigint`, nunca `float`/`numeric` con riesgo de redondeo binario. `currency text CHECK (currency = 'CLP')` — deliberadamente restringido a una sola moneda hoy; ampliar a multi-moneda es una migración aditiva futura, no se construyó esa flexibilidad sin un caso real. Confirmado por test: `amount < 0` rechazado tanto en `bonus_policies` como implícitamente en `employee_daily_bonuses` (mismo `CHECK`).

---

## 16. WeeklyReview

**Sin cambios de significado** respecto a Fase 2A: sigue siendo el "check semanal" (`OPEN → READY_TO_CLOSE → CLOSED → REOPENED`). Se le agregó únicamente una FK nullable (`reporting_period_id`) para poder agruparse bajo un período superior — aditivo, no rompe ninguna fila ni test existente.

---

## 17. ReportingPeriod

`reporting_periods`: nivel superior a `WeeklyReview`, para el cierre final (~1 mes, ciclo exacto **sin confirmar**, `P0`). `period_start`/`period_end` son fechas libres — nunca se asume "día 1 a último día del mes calendario". Estados (`reporting_period_status`, enum): `OPEN → IN_REVIEW → READY_TO_CLOSE → CLOSED → REOPENED` — incluye `IN_REVIEW` (a diferencia de `weekly_review_status`) porque un período puede estar activamente en revisión durante varias semanas antes de estar listo para cerrar. `EXCLUDE USING gist` anti-solapamiento, mismo criterio que `weekly_reviews`.

---

## 18. Period snapshot

`period_snapshots`: mismo patrón que `weekly_review_snapshots` de Fase 2A (referencias por ID a filas inmutables en `payload jsonb`, no duplicación de datos) — específicamente, referenciando los `weekly_review_snapshot_id` de las semanas que componen el período, en vez de reconstruir todo desde cero. Uno o más por `reporting_period` (igual criterio que `weekly_review_snapshots`: un reopen+recierre agrega un snapshot nuevo, nunca reemplaza el anterior).

---

## 19. Weekly check export

`excel_exports.export_scope = 'WEEKLY_CHECK'`: preview/borrador semanal para verificar que los datos estén correctos — **no** es el Excel de remuneraciones. Exige `weekly_review_id` + `snapshot_id` (las columnas originales de Fase 2A, ahora nullable a nivel de columna pero obligatorias para este scope vía `CHECK`).

## 20. Final period export

`excel_exports.export_scope = 'FINAL_PERIOD'`: el Excel definitivo del período cerrado. Exige `reporting_period_id` + `period_snapshot_id`, y **prohíbe** `weekly_review_id`/`snapshot_id` (un export final no pertenece a una sola semana). El `CHECK excel_exports_scope_references_chk` hace estos dos conjuntos de referencias mutuamente excluyentes — confirmado por test (`012_reporting_period.sql`, caso 5: un intento de `FINAL_PERIOD` con referencias de `WEEKLY_CHECK` es rechazado).

No se generó ningún archivo en esta fase — sigue siendo solo metadata, igual que en Fase 2A.

---

## 21. Daily Workera sync

`sync_runs` (Fase 2A) ya soporta correctamente la arquitectura de sincronización diaria automática confirmada en el encargo: cada corrida tiene su propio `started_at`/`finished_at`/`status`/`target_period_start`/`target_period_end`/contadores — no requirió ningún cambio de esquema. Las nuevas tablas sincronizables de Fase 2B (`attendance_status_records`, `employee_group_assignments`) se conectaron al mismo mecanismo (`sync_run_id` nullable FK), consistente con `attendance_records`/`absence_records` de Fase 2A. No se implementó `WorkeraClient`, API real, cron ni scheduler — fuera de alcance, confirmado explícitamente.

---

## 22. Manual/Workera reconciliation

**No se creó ninguna tabla ni mecanismo nuevo de "reconciliación".** El versionado ya existente (`source_version` + índice único parcial `is_current`) resuelve el escenario del encargo (08:00 entrada manual de licencia → 14:00 Workera trae la misma licencia) de forma estructural: el índice único parcial `(employee_id, work_date) WHERE is_current` impide que la fila de Workera se marque `is_current = true` mientras la manual sigue vigente — confirmado por test (`014_manual_workera_reconciliation.sql`): el segundo `INSERT` con `is_current = true` es rechazado por `UNIQUE`, forzando a que la fila de Workera se guarde como `is_current = false` (no vigente) hasta que un humano decida explícitamente cuál prevalece. **Ninguna de las dos versiones se pierde ni se fusiona silenciosamente** — ambas coexisten en la base, exactamente como pide el encargo.

---

## 23. Sync conflicts

Sin cambios respecto al mecanismo de Fase 2A (`SYNC_CONFLICT` en `daily_reviews`, hash/versión para detectar cambios relevantes). Las nuevas tablas versionadas de Fase 2B (`attendance_status_records`) siguen exactamente el mismo patrón (`source_hash`, `source_version`, `is_current`, trigger de inmutabilidad) — un cambio de Workera sobre un código de asistencia después de una novedad manual (o viceversa) es representable end-to-end sin sobrescritura silenciosa, tal como se confirma en la sección 22.

Conflicto "licencia + marcación" (`L` + `clock_in`/`clock_out`) y "vacaciones + marcación" (`V` + marcación): **no se implementaron como constraint de base de datos** (no hay forma limpia de expresarlo sin acoplar `attendance_status_records` a `attendance_records` con una regla que cambiaría según el código) — quedan documentados como validación `NEEDS_REVIEW`/`SYNC_CONFLICT` de la capa de aplicación (ver sección 24), consistente con cómo Fase 2A ya trató "vacaciones + horas trabajadas" (documentado, no forzado por constraint).

---

## 24. Validaciones — BLOCKING / WARNING (actualizado)

| Validación | Clasificación | Implementación |
|---|---|---|
| Employee sin `employee_group` | `BLOCKING` | Documentada (Fase 2A) — `employee_group_id` sigue nullable a propósito |
| Licencia + marcación | `BLOCKING` | Documentada — no es constraint (cruza `attendance_status_records`/`attendance_records`) |
| Vacaciones + marcación | `BLOCKING` | Documentada — igual criterio |
| `OvertimeDecision` inconsistente (`approved+rejected ≠ candidate`) | `BLOCKING` | **DB-enforced** (trigger, Fase 2A) |
| Bono sin `OvertimeDecision` elegible | `BLOCKING` | **DB-enforced** (trigger `validate_employee_daily_bonus`, Fase 2B) |
| Cierre final con semanas pendientes | `BLOCKING` | Documentada — no es trigger (sección 32 del encargo, mismo criterio que Fase 2A para `WeeklyReview`/`DailyReview`) |
| `SYNC_CONFLICT` sin resolver | `BLOCKING` | Documentada (estado `daily_reviews`, Fase 2A) |
| Documento con metadata inválida | `BLOCKING` (parcial) | **DB-enforced** (`CHECK` de `document_type`/`num_nonnulls`, Fase 2B) — la validez del archivo en sí (tamaño, tipo MIME real) queda para la integración de Storage, fuera de alcance |
| `period_end < period_start` (`reporting_periods`) | `BLOCKING` | **DB-enforced** (`CHECK`, Fase 2B) |
| `?` (tarjeta no marcada) | `WARNING`/`NEEDS_REVIEW` | `attendance_statuses.requires_review = true` — señal para la capa de aplicación, no un trigger que fuerce el estado de `daily_reviews` |
| `R` (recuperan horas) sin regla confirmada | `WARNING` | Documentada — `requires_review = false` a propósito (no se inventa una regla) |
| Entrada manual posteriormente encontrada en Workera | `WARNING` | Resuelto estructuralmente por versionado (sección 22), la decisión de cuál prevalece es de la aplicación |

No se implementaron todas como triggers — se diferenció explícitamente integridad estructural (lo que rompería la base si no se impide) de lógica operacional/de negocio (lo que pertenece a una fase de cálculo o revisión futura), siguiendo el criterio explícito del encargo.

---

## 25. Preguntas P0/P1/P2 (Fase 2B — no inventadas)

**P0 — bloquean el cálculo, no la estructura (mismo criterio que Fase 2A):**
- Regla exacta de overtime del viernes para Producción (sigue abierta desde Fase 2A).
- HH50 vs HH100 (sigue abierta desde Fase 2A).
- Horario sábado/domingo de Instalación.
- Overtime de Instalación (elegibilidad, tope, tasa).
- Si Instalación recibe el bono de $1.000 (`PENDING_BUSINESS_CONFIRMATION` explícito).
- Regla exacta de `R` (recuperan horas): cómo afecta overtime/atraso/remuneración.
- Ciclo exacto del `ReportingPeriod` (¿mes calendario? ¿otro ciclo de ~30 días?).

**P1 — importantes antes de implementación, no bloquean el diseño:**
- Tolerancia definitiva de atrasos (sigue en `0` por defecto desde Fase 2A).
- Autoridad final de descuentos (¿mismo rol que aprueba horas extra?).
- Si una semana/período cerrado puede reabrirse y quién autoriza.
- Vocabulario final si `category` de `attendance_statuses` necesita ajuste.

**P2 — sin impacto estructural conocido:**
- Viáticos (sigue `OUT_OF_SCOPE_PENDING_CONFIRMATION`).
- Significado de los colores del Excel original (Fase 2A, sin cambios).
- Si `document_type` necesita crecer a un catálogo completo.

---

## Impacto futuro en Auth/RLS (preparación, no implementación — sección 52 del encargo)

Roles mínimos a considerar en Fase 3, ya insinuados por el modelo de datos:

- **ADMIN/RRHH**: acceso completo, incluidos documentos privados.
- **SUPERVISOR PRODUCTION**: acceso a trabajadores con `employee_group = PRODUCTION` asignados vía `supervisor_assignments`.
- **SUPERVISOR INSTALLATION**: mismo mecanismo, `employee_group = INSTALLATION`.

La autorización real **debe depender de `supervisor_assignments` (vigencia por fecha), nunca solo del nombre del rol** — el esquema ya lo soporta sin cambios adicionales: una política RLS futura puede hacer `EXISTS (SELECT 1 FROM supervisor_assignments WHERE employee_id = <fila> AND supervisor_profile_id = auth.uid() AND daterange(...) @> <fecha>)`.

Documentos privados (`supporting_documents`) requerirán una política adicional más estricta que el acceso a datos de asistencia — se documenta como requisito de Fase 3, no se implementa aquí.

`profiles.role` (Fase 2A: `admin`/`supervisor`) es suficiente para distinguir el rol técnico; distinguir "supervisor de qué grupo" no requiere una tercera opción de rol — se deriva de qué `employee_group` tienen los trabajadores en sus `supervisor_assignments`, evitando un enum de roles que crecería innecesariamente (`supervisor_production`, `supervisor_installation`, ...).
