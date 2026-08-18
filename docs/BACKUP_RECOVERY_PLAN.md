# Backups y Recuperación — plan (propuesta, no implementada)

Estado: `PLANNED`. **No existe ninguna estrategia de backup implementada.** No existe ningún proyecto Supabase remoto (staging o producción) — solo el stack local vía Supabase CLI, que se destruye y reconstruye en cada `supabase db reset` (24 migraciones desde cero) como parte del flujo normal de desarrollo y CI. **No se afirma que Supabase realice backups de este proyecto** porque no hay ningún plan contratado todavía.

Fuente oficial consultada en este gate: [Supabase — Backups](https://supabase.com/docs/guides/platform/backups).

Ver también: `docs/THREAT_MODEL.md` (T-17, pérdida de datos), `ARCHITECTURE.md`.

## 1. Separación por entorno

### 1.1 Entorno local actual (`IMPLEMENTED`, sin backup — y no lo necesita)
- Stack Supabase vía Docker (CLI), efímero por diseño. Se reconstruye desde las 24 migraciones versionadas en `supabase/migrations/` — **las migraciones en Git son, en sí mismas, la fuente de verdad recuperable del esquema**, no un backup de datos.
- Datos de desarrollo/CI son sintéticos (seeds, fixtures de test) — su pérdida no tiene impacto de negocio.
- No requiere backup. Riesgo residual: ninguno relevante.

### 1.2 Futuro staging (`PLANNED`)
- No existe todavía. Cuando exista, debe tener su propia estrategia de backup independiente de producción, con datos que puedan purgarse sin el mismo nivel de garantía que producción.
- RPO/RTO propuestos para staging: más laxos que producción (ej. RPO 24h, RTO 24h) — `PROPOSED`, no decidido.

### 1.3 Futura producción (`PLANNED` — la sección más crítica de este documento)
- No existe ningún proyecto Supabase de producción contratado. Todo lo siguiente es diseño anticipado, sujeto a las capacidades reales del plan que se contrate.

## 2. Qué debe respaldarse (cuando exista producción)

| Dato | Origen | Estrategia propuesta |
|---|---|---|
| Postgres (34 tablas, todo el modelo de negocio) | Base de datos Supabase | Backups automáticos del proveedor + snapshots propios — `TBD` según plan contratado |
| Migraciones (esquema) | `supabase/migrations/` en Git | Ya versionado en Git — el repositorio Git **es** el backup del esquema, con GitHub como respaldo remoto (ya implementado, Gate A) |
| Configuraciones (`supabase/config.toml`, variables de entorno) | Repositorio + gestor de secretos futuro | Config en Git (sin secretos); secretos en un gestor dedicado (`TBD` — no definido, `.env.local` nunca debe ser el mecanismo de backup de un secreto de producción) |
| Documentos de respaldo (Storage, futuro) | Bucket privado de Supabase Storage (no implementado) | `TBD` — depende de las capacidades de backup de Storage del plan contratado |
| Logs de aplicación | Plataforma de hosting/observabilidad futura | `TBD` — no definido, depende de la herramienta de logging elegida |
| `audit_log` | Postgres (tabla ya implementada, append-only) | Cubierto por el backup general de Postgres; su integridad depende además de la inmutabilidad ya garantizada por trigger (ver `docs/THREAT_MODEL.md` T-18) |
| Excel generado (futuro) | Artefacto derivado, regenerable desde Postgres | Propuesta: **no requiere backup dedicado** si los datos fuente en Postgres están respaldados — es reproducible bajo demanda, a diferencia de un dato primario |

## 3. RPO / RTO propuestos (no aprobados)

| Entorno | RPO propuesto | RTO propuesto | Estado |
|---|---|---|---|
| Local (dev/CI) | N/A | N/A | No aplica — efímero por diseño |
| Staging | 24 horas | 24 horas | `PROPOSED`, no decidido |
| Producción | 1 hora | 4 horas | `PROPOSED`, no decidido — depende de si el plan Supabase contratado soporta Point-in-Time Recovery (PITR); sin PITR, un RPO de 1 hora no es alcanzable solo con snapshots diarios |

Estos valores son un punto de partida para la conversación con quien defina el plan de negocio — **no son un compromiso operacional**. Deben confirmarse contra la capacidad real del plan Supabase que se contrate (ver `docs/DECISIONS_PENDING.md`).

## 4. Frecuencia, retención, cifrado, acceso

| Aspecto | Propuesta |
|---|---|
| Frecuencia de backup | `TBD` — depende enteramente del plan Supabase que se contrate. **Hecho verificado contra documentación oficial de Supabase (Backups):** el plan **Free no incluye backups automáticos** (requiere exportación manual); Pro ofrece 7 días de backups diarios, Team 14 días, Enterprise hasta 30 días; PITR (Point-in-Time Recovery, granularidad de segundos) es un add-on disponible desde Pro en adelante, con ventana de recuperación de 7-28 días. Un RPO de 1 hora (sección 3) **no es alcanzable en el plan Free ni sin contratar PITR explícitamente** |
| Retención | `TBD` — propuesta inicial 30 días para backups operacionales; requiere alinear con cualquier obligación legal/laboral chilena sobre retención de datos de remuneración (no evaluado en este gate, fuera de alcance técnico) |
| Cifrado en reposo | Depende del proveedor (Supabase cifra at-rest por defecto en su infraestructura estándar) — **no verificado contra un proyecto real todavía**, no asumir sin confirmar contra el plan contratado |
| Cifrado en tránsito | HTTPS ya es la base del diseño (Supabase Auth, RLS vía `supabase-js`) — a confirmar en el dominio de producción real cuando exista |
| Acceso a backups | Propuesta: exclusivo a quien administre la infraestructura (rol operacional, distinto de `ADMIN_RRHH` de la app) — separación de responsabilidades explícita, no implementada |
| Eliminación segura | `TBD` — depende del mecanismo de retención/expiración del proveedor; ningún comando de eliminación manual debe ejecutarse contra un backup sin doble confirmación y sin ambigüedad de destino |

## 5. Separación de responsabilidades

Propuesta (no implementada, no hay equipo de operaciones definido todavía):
- Quien opera backups/restauración **no debería ser la misma persona que aprueba datos de negocio dentro de la app** (`ADMIN_RRHH`) — evita que una sola cuenta comprometida controle tanto los datos operativos como su respaldo/recuperación.
- Acceso a backups debe ser auditable independientemente de `audit_log` de la aplicación (que cubre acciones dentro de la app, no acceso a infraestructura).

## 6. Runbook de restauración — `UNTESTED — REQUIRES STAGING/PRODUCTION`

**Este runbook no ha sido ejecutado ni validado contra ningún entorno real.** Es una secuencia de pasos verificables en su forma (comandos correctos en principio), pero su corrección operacional real **no está probada**. No debe considerarse confiable hasta ejecutar un restore real en staging.

0. **Confirmar explícitamente el proyecto y entorno de destino** (nombre/ID del proyecto Supabase, staging vs. producción) antes de tocar cualquier consola o CLI — ningún paso siguiente debe ejecutarse si existe la más mínima ambigüedad sobre contra qué proyecto se está actuando. Registrar quién autorizó la restauración.
1. Confirmar el incidente: ¿pérdida de datos, corrupción, o eliminación accidental? Identificar el punto en el tiempo objetivo de restauración (antes del incidente).
2. Congelar escritura al sistema afectado si es posible (modo mantenimiento) para evitar que nueva actividad se pierda o se mezcle con datos restaurados incorrectamente.
3. Identificar el backup/snapshot más reciente anterior al punto objetivo (vía la consola/API del proveedor Supabase, cuando exista ese proyecto).
4. Restaurar en un entorno **aislado** (nunca directamente sobre producción sin pasar por un ambiente de verificación) — `TBD` el mecanismo exacto según lo que ofrezca el plan contratado (clon de proyecto, restore in-place, etc.).
5. Validar integridad post-restore: correr la suite pgTAP (`supabase test db --local supabase/tests`, hoy 119/119) contra el entorno restaurado para confirmar que el esquema y las políticas RLS quedaron consistentes — mismo mecanismo ya usado en CI (Gate A), reutilizable aquí como validación, no solo como test de desarrollo.
6. Validar conteos/checksums de tablas críticas contra lo esperado (sin definir aún qué checksum exacto — `TBD`).
7. Si la restauración es satisfactoria, redirigir tráfico/producción al entorno restaurado; si no, escalar y no continuar destruyendo el estado previo hasta tener un plan claro.
8. Documentar el incidente: causa raíz, ventana de datos perdidos (si el RPO no se cumplió), acciones correctivas.
9. Levantar el modo mantenimiento.

**Ninguno de estos pasos debe ejecutarse contra un proyecto real sin que un humano con autoridad explícita lo apruebe.** Este documento no autoriza ninguna acción destructiva por sí mismo.

## 7. Escenarios cubiertos por el diseño (todos `PLANNED`, ninguno probado)

| Escenario | Cobertura propuesta |
|---|---|
| Corrupción de datos | Restore desde snapshot anterior a la corrupción (requiere backups con suficiente granularidad temporal) |
| Pérdida accidental (`DELETE`/`DROP` humano) | Mismo mecanismo — depende de PITR o snapshots frecuentes para minimizar la ventana de pérdida |
| Ransomware / compromiso de infraestructura | Backups deben estar aislados del sistema productivo (no accesibles con las mismas credenciales que la app) — principio de diseño, no implementado |
| Incidente de seguridad con necesidad de rollback | Mismo runbook, con el paso adicional de rotar credenciales comprometidas antes de restaurar |
| Dependencia del plan contratado de Supabase | Todo este documento asume capacidades que deben confirmarse contra el plan real elegido — un plan gratuito/básico puede no ofrecer PITR ni la retención propuesta en la sección 4 |

## 8. Qué NO está implementado (recordatorio explícito)

No existe backup automatizado, no existe proyecto de producción, no existe runbook probado, no existe separación de responsabilidades operacional formalizada. Este documento es la base de diseño para cuando esas piezas existan — no debe citarse como evidencia de que el proyecto ya tiene una estrategia de recuperación ante desastres operativa.
