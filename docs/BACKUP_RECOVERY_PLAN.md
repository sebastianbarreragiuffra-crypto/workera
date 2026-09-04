# Backups y Recuperación — plan actualizado (propuesta, no validada)

Estado al 4 de septiembre de 2026: `PLANNED / UNVERIFIED`. Existe un proyecto
Supabase de staging y hay evidencia de migraciones aplicadas, pero **no existe
evidencia de backup automático, PITR ni una restauración probada**. No existe un
proyecto de producción declarado. Staging no debe citarse como respaldo ni como
prueba de recuperación hasta ejecutar el runbook en un destino aislado. Como
contiene 97 registros de empleados, permanece `NO-GO` para nuevas pruebas con PII
o conectores reales hasta sanearse o aplicar controles equivalentes a producción.

Fuente oficial consultada en este gate: [Supabase — Backups](https://supabase.com/docs/guides/platform/backups).

Ver también: `docs/TARGET_ARCHITECTURE_PHASES_2_6.md` y
`docs/STAGING_ENVIRONMENT.md`.

## 1. Separación por entorno

### 1.1 Entorno local actual (`IMPLEMENTED`, efímero)
- Stack Supabase vía Docker (CLI), efímero por diseño. Se reconstruye desde el historial versionado en `supabase/migrations/` — **las migraciones en Git son la fuente recuperable del esquema, no un backup de datos**.
- Datos de desarrollo/CI son sintéticos (seeds, fixtures de test) — su pérdida no tiene impacto de negocio.
- No requiere backup. Riesgo residual: ninguno relevante.

### 1.2 Staging actual (`EXISTS`, recuperación `UNVERIFIED`)
- Existe un proyecto remoto de staging. Su plan contratado, retención de backups,
  cobertura de Storage y capacidad PITR deben verificarse en el Dashboard/contrato.
- Debe tener su propia estrategia de backup independiente de producción y usar
  datos sintéticos o minimizados siempre que sea posible.
- RPO/RTO propuestos para staging: más laxos que producción (ej. RPO 24h, RTO 24h) — `PROPOSED`, no decidido.

### 1.3 Futura producción (`PLANNED` — la sección más crítica de este documento)
- No existe ningún proyecto Supabase de producción contratado. Todo lo siguiente es diseño anticipado, sujeto a las capacidades reales del plan que se contrate.

## 2. Qué debe respaldarse (cuando exista producción)

| Dato | Origen | Estrategia propuesta |
|---|---|---|
| Postgres (modelo de negocio completo) | Base de datos Supabase | Backups automáticos del proveedor + snapshots propios — `TBD` según plan contratado |
| Migraciones (esquema) | `supabase/migrations/` en Git | Ya versionado en Git — el repositorio Git **es** el backup del esquema, con GitHub como respaldo remoto (ya implementado, Gate A) |
| Configuraciones (`supabase/config.toml`, variables de entorno) | Repositorio + gestor de secretos futuro | Config en Git (sin secretos); secretos en un gestor dedicado (`TBD` — no definido, `.env.local` nunca debe ser el mecanismo de backup de un secreto de producción) |
| Documentos, comprobantes y archivos | Buckets privados de Supabase Storage | `TBD` — verificar si el mecanismo contratado cubre objetos y metadata; un backup de Postgres por sí solo no recupera los binarios |
| Logs de aplicación | Plataforma de hosting/observabilidad futura | `TBD` — no definido, depende de la herramienta de logging elegida |
| `audit_log` | Postgres (append-only para roles de aplicación) | Cubierto por el backup general de Postgres. El trigger no protege frente a un administrador de proyecto/base; antes de usar PII real se requiere un sink separado tamper-evident, con retención y acceso independientes (ver `docs/THREAT_MODEL_CURRENT.md` TM-13) |
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
| Frecuencia de backup | `TBD` — depende del plan y add-ons que se contraten. Antes de aprobar los RPO/RTO hay que verificar en el Dashboard, contrato y [documentación oficial vigente](https://supabase.com/docs/guides/platform/backups) qué backups automáticos, retención y PITR cubre exactamente el proyecto. No se debe inferir la capacidad por el nombre comercial del plan ni reutilizar cifras históricas. Un RPO de 1 hora exige una capacidad demostrada de recuperación continua o snapshots equivalentes, además de una restauración ensayada |
| Retención | `TBD` — propuesta inicial 30 días para backups operacionales; requiere alinear con cualquier obligación legal/laboral chilena sobre retención de datos de remuneración (no evaluado en este gate, fuera de alcance técnico) |
| Cifrado en reposo | Depende del proveedor (Supabase cifra at-rest por defecto en su infraestructura estándar) — **no verificado contra un proyecto real todavía**, no asumir sin confirmar contra el plan contratado |
| Cifrado en tránsito | HTTPS ya es la base del diseño (Supabase Auth, RLS vía `supabase-js`) — a confirmar en el dominio de producción real cuando exista |
| Acceso a backups | Propuesta: exclusivo a quien administre la infraestructura (rol operacional, distinto de `ADMIN_RRHH` de la app) — separación de responsabilidades explícita, no implementada |
| Eliminación segura | `TBD` — depende del mecanismo de retención/expiración del proveedor; ningún comando de eliminación manual debe ejecutarse contra un backup sin doble confirmación y sin ambigüedad de destino |

La copia propia objetivo debe estar cifrada y aislada de las credenciales de la
aplicación/proyecto (cuenta o proveedor distinto, off-site y con inmutabilidad/WORM
cuando sea viable). Cada ejecución genera un manifiesto firmado o almacenado en un
sink inmutable con punto de corte, tablas, objetos, tamaños y checksums; una alerta
se dispara si falta, llega tarde o no valida. La consistencia DB–Storage se obtiene
con un freeze corto o un protocolo versionado que permita reconciliar cambios
posteriores, no con dos copias independientes sin watermark.

## 5. Separación de responsabilidades

Propuesta (no implementada, no hay equipo de operaciones definido todavía):
- Quien opera backups/restauración **no debería ser la misma persona que aprueba datos de negocio dentro de la app** (`ADMIN_RRHH`) — evita que una sola cuenta comprometida controle tanto los datos operativos como su respaldo/recuperación.
- Acceso a backups debe ser auditable independientemente de `audit_log` de la aplicación (que cubre acciones dentro de la app, no acceso a infraestructura).

## 6. Runbook de restauración — `UNTESTED`

**Este runbook no ha sido ejecutado.** La restauración se ensaya en un proyecto
nuevo y aislado. Nunca debe apuntar primero al proyecto afectado.

0. Registrar proyecto origen, incidente, punto objetivo, RPO/RTO, operador,
   aprobador y destino exacto. Detenerse ante cualquier ambigüedad.
1. Activar modo mantenimiento y deshabilitar webhooks, cron, sync, correo,
   WhatsApp, OCR, contabilidad y otras escrituras externas. Preservar evidencia.
2. Rotar o revocar credenciales si existe compromiso; conservar acceso forense
   separado. Elegir backup/PITR anterior al incidente.
3. Crear/restaurar un **proyecto aislado** conforme a la guía vigente de Supabase.
   No asumir que un clon de base replica Auth settings, API keys, Realtime,
   extensiones, dominios, secretos, cron o integraciones: mantener un checklist de
   reconfiguración y nuevas credenciales.
4. Restaurar Postgres y reconstruir buckets/policies. Restaurar los binarios desde
   la copia independiente de Storage que corresponda al mismo punto de corte; un
   backup de base solo recupera metadata, no objetos.
5. Verificar el destino mediante una URL explícita y revisada. **No usar
   `supabase test db --local`**, porque probaría el Docker local. Crear antes del
   drill una suite `restore-smoke` read-only que reciba `--db-url`/project ref y
   compruebe versiones de migración, RLS/policies/grants, funciones, conteos y
   manifiestos sin insertar fixtures. La suite pgTAP completa solo puede ejecutarse
   sobre un segundo clon descartable o dentro de un procedimiento transaccional
   aprobado, nunca sobre la copia candidata a cutover.
6. Comparar manifest de tablas críticas y Storage: conteos, claves, tamaños y
   checksums por objeto; reconciliar metadata sin binario, binario huérfano,
   versiones y punto de corte. Validar URLs firmadas y permisos con cuentas de
   prueba, sin abrir objetos reales de forma indiscriminada.
7. Desplegar la versión de aplicación compatible y configurar Auth/OAuth, API
   keys, Realtime, SMTP, DNS, secretos y jobs con credenciales nuevas. Ejecutar
   canarios sin efectos externos y mantener proveedores apagados.
8. Medir RPO/RTO y ejecutar un plan de cutover reversible. Conservar el origen en
   solo lectura; definir criterios y ventana de rollback antes de mover tráfico.
9. Tras aprobación humana, habilitar tráfico gradualmente, reconciliar eventos
   ocurridos durante el freeze y luego reactivar integraciones por canal.
10. Documentar causa, datos perdidos, evidencia, checksums, decisiones, tiempos y
    acciones correctivas; programar el siguiente drill.

Ningún paso autoriza acciones destructivas. Antes de producción debe ejecutarse un
drill trimestral propuesto (cadencia final por aprobar) que incluya DB, Storage,
configuración, cutover y rollback.

## 7. Escenarios cubiertos por el diseño (todos `PLANNED`, ninguno probado)

| Escenario | Cobertura propuesta |
|---|---|
| Corrupción de datos | Restore desde snapshot anterior a la corrupción (requiere backups con suficiente granularidad temporal) |
| Pérdida accidental (`DELETE`/`DROP` humano) | Mismo mecanismo — depende de PITR o snapshots frecuentes para minimizar la ventana de pérdida |
| Ransomware / compromiso de infraestructura | Backups deben estar aislados del sistema productivo (no accesibles con las mismas credenciales que la app) — principio de diseño, no implementado |
| Incidente de seguridad con necesidad de rollback | Mismo runbook, con el paso adicional de rotar credenciales comprometidas antes de restaurar |
| Dependencia del plan contratado de Supabase | Todo este documento asume capacidades que deben confirmarse contra el plan real elegido — un plan gratuito/básico puede no ofrecer PITR ni la retención propuesta en la sección 4 |

## 8. Qué NO está implementado (recordatorio explícito)

No hay evidencia de backup automatizado o PITR en staging, no existe proyecto de
producción declarado, no existe restore drill aprobado y no está formalizada la
separación de responsabilidades operacional. Este documento no debe citarse como
evidencia de recuperación ante desastres operativa.
