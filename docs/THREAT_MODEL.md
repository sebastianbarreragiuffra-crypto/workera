# Threat Model — Workera Supervisor App

> **Documento histórico, no usar como evaluación vigente.** Fue escrito antes de
> que existieran la UI, Route Handlers, Storage, service-role, Workera real y las
> Fases 2–6 de Rendiciones; por eso varias afirmaciones posteriores describen esas
> superficies como futuras o inexistentes. La evaluación actual, los riesgos
> residuales y los bloqueos están en `docs/THREAT_MODEL_CURRENT.md`; la arquitectura
> y los gates están en `docs/TARGET_ARCHITECTURE_PHASES_2_6.md`. Este contenido se
> conserva únicamente para trazabilidad histórica STRIDE.

Estado: creado en Gate C pre-UI (rama `fix-pre-ui-session-guard`). Metodología: **STRIDE** (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege), complementado con riesgos de privacidad y abuso. Cada amenaza distingue mitigaciones `IMPLEMENTED` (verificadas en el código/CI actual) de `PLANNED`/`BLOCKED`. No se documenta ninguna mitigación como implementada sin evidencia directa contra el repositorio.

Ver también: `ARCHITECTURE.md` (componentes y su estado), `docs/API_SECURITY_STANDARD.md`, `docs/ABUSE_RATE_LIMITING_PLAN.md`, `docs/BACKUP_RECOVERY_PLAN.md`, `docs/DECISIONS_PENDING.md`.

## 1. Activos

| Activo | Sensibilidad |
|---|---|
| Credenciales de usuario (email/password vía Supabase Auth) | Alta |
| Sesiones (cookies JWT) | Alta |
| Datos personales de trabajadores (`employees`) | Alta |
| Asistencia/atrasos/horas extra (`attendance_records`, `late_arrival_records`, `overtime_records`) | Media-Alta |
| Bonos (`employee_daily_bonuses`) | Media |
| Ausencias/licencias (`absence_records`, tipos médicos incluidos) | Alta (dato de salud) |
| Documentos de respaldo/justificativos (`supporting_documents`) | Alta — metadata hoy, contenido de archivo cuando exista Storage |
| Excel generado (`excel_exports`, futuro) | Media-Alta — agrega datos de remuneración |
| Logs de aplicación | Media — deben estar libres de PII/secretos por diseño |
| `audit_log` | Alta — integridad es crítica para trazabilidad |
| Backups (futuros) | Alta — superset de todo lo anterior |
| Credenciales de Workera (`WORKERA_API_USER`, `WORKERA_API_KEY`, `WORKERA_BASE_URL`) | Alta |
| `SUPABASE_SERVICE_ROLE_KEY` (futuro, cuando exista un uso real) | Crítica — bypassea RLS |

## 2. Actores

| Actor | Descripción |
|---|---|
| Trabajador | No tiene cuenta ni acceso a la app (fuente de datos, no usuario) |
| Supervisor (`SUPERVISOR_PRODUCTION` / `SUPERVISOR_INSTALLATION`) | Acceso de lectura amplia + escritura scoped a su grupo, vía RLS |
| `ADMIN_RRHH` | Acceso administrativo completo dentro de la app |
| Servicio Workera | Fuente de datos externa, hoy simulada por `MockWorkeraClient` |
| `service_role` de Supabase | Bypassea RLS; hoy no usado por ningún código bajo `src/` (verificado, `docs/SECURITY_PHASE3.md`) |
| Atacante externo | Sin credenciales válidas, interactúa vía red pública |
| Usuario interno malicioso | Cuenta corporativa legítima usada de forma abusiva |
| Operador/desarrollador | Acceso a repositorio, CI, y (futuro) infraestructura de producción |

## 3. Límites de confianza

Navegador → Next.js Proxy → Supabase Auth → Postgres/RLS → (futuro) Supabase Storage → (bloqueado) Workera → GitHub Actions (CI) → (futuro) backup. Cada flecha es un límite de confianza distinto; ver `ARCHITECTURE.md` sección 11 para el detalle de estado por límite.

## 4. Matriz de amenazas

Formato por amenaza: ID · Activo · Actor · Vector · Impacto · Probabilidad · **Severidad inherente** (la severidad del impacto si la amenaza se materializara sin ninguna mitigación) · **Estado** (`ACTIVE` = la superficie ya existe hoy; `FUTURE_SURFACE` = la superficie no existe todavía, solo aplicará cuando se construya la funcionalidad; `MITIGATED` = superficie activa pero con control verificado que reduce el riesgo residual a Bajo; `BLOCKED_EXTERNAL` = depende de un tercero fuera del control del equipo; `NOT_APPLICABLE_CURRENTLY` = ni la superficie ni una fecha de activación concreta existen) · Mitigaciones implementadas · Mitigaciones pendientes · Evidencia · **Riesgo residual actual** · **Riesgo residual futuro** (si las mitigaciones pendientes no se implementan antes de que la superficie se active) · Momento obligatorio.

**Regla aplicada de forma consistente:** ninguna amenaza se etiqueta "crítica activa" salvo que su superficie de ataque exista hoy Y carezca de mitigación verificada. Ver conclusión explícita en la sección 5.

---

**T-01 — Robo de sesión (session hijacking)**
Activo: sesiones. Actor: atacante externo, usuario interno malicioso. Vector: robo de cookie (XSS, red insegura, malware en el dispositivo). Impacto: suplantación completa del usuario. Probabilidad: Media. Severidad inherente: **Alta**. Estado: `ACTIVE` (login ya existe).
Implementadas: cookies gestionadas exclusivamente por `@supabase/ssr` (nunca manipuladas manualmente por código de aplicación); `getClaims()` verifica el JWT en cada request en vez de confiar ciegamente en el valor de la cookie.
Pendientes: `HttpOnly`/`Secure`/`SameSite` dependen de los defaults de `@supabase/ssr` — no se ha auditado explícitamente cada atributo en producción (no existe producción todavía); rotación/expiración de sesión no revisada a fondo.
Evidencia: `src/lib/supabase/middleware.ts`, tests de preservación de atributos de cookie en `middleware.test.ts` (26/26).
Riesgo residual actual: Medio. Riesgo residual futuro: Medio (persiste hasta auditar atributos contra el dominio real de producción). Momento: antes de producción.

**T-02 — Token JWT falsificado / manipulado**
Activo: sesiones, todos los datos protegidos por RLS. Actor: atacante externo. Vector: JWT modificado o firmado con clave incorrecta enviado como cookie. Impacto: acceso no autorizado si la verificación fallara. Probabilidad: Baja. Severidad inherente: **Alta**. Estado: `MITIGATED`.
Implementadas: `getClaims()` realiza verificación criptográfica del JWT (no decodifica sin validar); fail closed ante cualquier error de verificación.
Pendientes: ninguna — mitigación depende de la librería oficial de Supabase, no de código propio.
Evidencia: `middleware.ts`, tests "token inválido" y "claims sin sub"/"sub vacío" (26/26).
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo. Momento: N/A (ya mitigado por diseño).

**T-03 — IDOR/BOLA (acceso a recursos de otro usuario)**
Activo: `employees`, asistencia, decisiones, documentos. Actor: usuario interno malicioso (supervisor intentando acceder a datos de otro grupo). Vector: manipular un ID en una request. Impacto: exposición de datos de trabajadores fuera del alcance del supervisor. Probabilidad: Media. Severidad inherente: **Alta**. Estado: `MITIGATED` a nivel de base de datos hoy; `FUTURE_SURFACE` a nivel de API (no existe ninguna todavía).
Implementadas: RLS con `can_manage_employee()` scoped por grupo del trabajador; test dedicado pgTAP `017_scoped_write_and_idor.sql`.
Pendientes: cuando existan Route Handlers reales, deben re-validar pertenencia server-side sin confiar en el ID del cliente (ver `docs/API_SECURITY_STANDARD.md`).
Evidencia: migraciones `rls_*`, `supabase/tests/017_scoped_write_and_idor.sql` (parte de 119/119).
Riesgo residual actual: Bajo (RLS ya cubre el único vector de acceso a datos que existe hoy). Riesgo residual futuro: Medio si se construye una API sin seguir el estándar; Bajo si se sigue. Momento: antes de exponer UI/API.

**T-04 — Elevación de privilegios (escalar a `ADMIN_RRHH`)**
Activo: `profiles.role`, todos los datos. Actor: usuario interno malicioso. Vector: intentar modificar el propio rol vía la API de Supabase. Impacto: control total de la app. Probabilidad: Baja. Severidad inherente: **Crítica**. Estado: `MITIGATED` (superficie activa — cuentas ya existen — con control verificado).
Implementadas: `profiles_update_admin_only` — UPDATE de `profiles` (incluido `role`) exclusivo `is_admin_rrhh()`; trigger de creación (`handle_new_auth_user()`) siempre asigna `role = NULL`, nunca un rol por defecto; test pgTAP `016_role_management_and_escalation.sql`.
Pendientes: ninguna identificada a nivel de base de datos.
Evidencia: `20260817152004_auth_roles_and_helpers.sql`, `supabase/tests/016_role_management_and_escalation.sql`.
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo. Momento: N/A.

**T-05 — Bypass de RLS**
Activo: todos los datos. Actor: atacante externo, usuario interno malicioso. Vector: uso de un privilegio de tabla no cubierto por policy (ej. `TRUNCATE`, que no está sujeto a RLS). Impacto: lectura/escritura/borrado no autorizado. Probabilidad: Baja (ya mitigado). Severidad inherente: **Crítica**. Estado: `MITIGATED`.
Implementadas: `grants_lockdown` — `REVOKE ALL` + `GRANT` explícito mínimo por tabla para `anon`/`authenticated`; verificación automática en la propia migración que falla si alguna tabla de `public` no tiene RLS habilitado; test `015_anon_denied.sql`.
Pendientes: ninguna identificada.
Evidencia: `20260817153423_grants_lockdown.sql`, `supabase/tests/015_anon_denied.sql`.
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo. Momento: N/A.

**T-06 — `service_role` expuesto**
Activo: todos los datos (bypass total de RLS). Actor: atacante externo, operador/desarrollador (error humano). Vector: `SUPABASE_SERVICE_ROLE_KEY` filtrada en código, logs, bundle de cliente, o repositorio. Impacto: control total de la base de datos. Probabilidad: Baja hoy (no se usa). Severidad inherente: **Crítica**. Estado: `MITIGATED` hoy (ausencia total de uso) / `FUTURE_SURFACE` cuando se implemente el primer uso real.
Implementadas: ningún archivo bajo `src/` usa `service_role` actualmente (verificado, `docs/SECURITY_PHASE3.md`); `.env.example` solo declara `SUPABASE_SERVICE_ROLE_KEY=` vacío, sin valor real.
Pendientes: cuando se implemente el primer uso legítimo (ej. sync de Workera), debe aislarse en un módulo `server-only` dedicado, nunca reutilizado por Route Handlers de usuario.
Evidencia: `ARCHITECTURE.md` sección 6, `.env.example`.
Riesgo residual actual: Bajo (no hay superficie: la clave no se usa en ningún código). Riesgo residual futuro: Medio si el primer uso real no aísla el módulo correctamente. Momento: antes de implementar cualquier código que use `service_role`.

**T-07 — SQL injection**
Activo: Postgres. Actor: atacante externo. Vector: input no parametrizado en una query. Impacto: lectura/escritura arbitraria. Probabilidad: Baja. Severidad inherente: **Crítica**. Estado: `MITIGATED`.
Implementadas: todo el acceso a datos pasa por el cliente `supabase-js` (queries parametrizadas por diseño, sin concatenación de SQL en código de aplicación); no existe ningún Route Handler ni endpoint que construya SQL dinámico.
Pendientes: si en el futuro se necesita SQL dinámico (ej. reportes), debe usar `format()`/parámetros de Postgres explícitamente, nunca interpolación de strings.
Evidencia: ausencia de queries SQL crudas en `src/` (todo vía `supabase-js`).
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo, salvo que se agregue SQL dinámico sin seguir la mitigación pendiente. Momento: N/A hoy; revisar si se agrega SQL dinámico.

**T-08 — CSRF**
Activo: acciones de escritura (login, futuras aprobaciones). Actor: atacante externo (sitio malicioso). Vector: request forjada desde otro origen usando la cookie de sesión del usuario. Impacto: acción no deseada ejecutada en nombre del usuario. Probabilidad: Media. Severidad inherente: **Media**. Estado: `MITIGATED` (superficie activa vía login, cubierta por protección nativa de Next.js).
Implementadas: Server Actions de Next.js incluyen protección CSRF nativa (verificación de origen); `login`/`logout` son Server Actions, no endpoints GET con efectos secundarios.
Pendientes: cuando existan Route Handlers reales, deben aplicar la misma disciplina — cubierto en `docs/API_SECURITY_STANDARD.md`.
Evidencia: `src/app/login/actions.ts` (`"use server"`).
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo si se sigue el estándar al agregar Route Handlers. Momento: antes de agregar Route Handlers de escritura.

**T-09 — XSS**
Activo: sesión, datos mostrados en UI (futura). Actor: atacante externo, usuario interno malicioso (input malicioso). Vector: contenido no sanitizado renderizado en el DOM. Impacto: robo de sesión, acciones no autorizadas. Probabilidad: Media (cuando exista UI de datos). Severidad inherente: **Alta**. Estado: `FUTURE_SURFACE` (la única página real, `/login`, no renderiza datos de terceros).
Implementadas: React escapa por defecto todo contenido renderizado (sin `dangerouslySetInnerHTML` en el código actual — verificado, `LoginPage` no lo usa).
Pendientes: al construir la UI de datos, ningún `dangerouslySetInnerHTML` sin sanitización explícita.
Evidencia: `src/app/login/page.tsx`.
Riesgo residual actual: N/A (sin UI de datos que renderice contenido de terceros). Riesgo residual futuro: Medio cuando exista UI, mitigable con la disciplina ya aplicable de React. Momento: durante la fase de UI.

**T-10 — SSRF**
Activo: red interna, credenciales de Workera. Actor: usuario interno malicioso, atacante externo (si controla algún input usado en una request server-side). Vector: manipular una URL de destino en una llamada server-side (ej. al implementar `HttpWorkeraClient`). Impacto: acceso a servicios internos o exfiltración. Probabilidad: Baja hoy (no existe ningún cliente HTTP real). Severidad inherente: **Alta**. Estado: `FUTURE_SURFACE` (bloqueado, `HttpWorkeraClient` no existe).
Implementadas: no aplica todavía.
Pendientes: cuando se implemente `HttpWorkeraClient`, la Base URL debe ser una constante de configuración server-only, nunca derivada de input de usuario.
Evidencia: ausencia de `HttpWorkeraClient` (`docs/WORKERA_PHASE5C_BLOCKED.md`).
Riesgo residual actual: N/A (superficie inexistente). Riesgo residual futuro: Alto si `HttpWorkeraClient` se implementa sin seguir la mitigación pendiente. Momento: al implementar cualquier cliente HTTP saliente.

**T-11 — Brute force / credential stuffing en login**
Activo: credenciales, sesiones. Actor: atacante externo. Vector: intentos automatizados de login. Impacto: compromiso de cuenta. Probabilidad: Media. Severidad inherente: **Alta**. Estado: `ACTIVE` — sin mitigación propia suficiente.
Implementadas: rate limits por defecto de Supabase Auth **en el entorno local de desarrollo** (`supabase/config.toml`, `[auth.rate_limit]`) — **no confirmados como aplicables a un proyecto Supabase hosted real** (no existe todavía); esto no es una mitigación de producción, es un dato de configuración de desarrollo.
Pendientes: sin rate limiting propio a nivel de aplicación; sin CAPTCHA (bloque `[auth.captcha]` presente pero deshabilitado); sin MFA. Ver `docs/ABUSE_RATE_LIMITING_PLAN.md`.
Evidencia: `supabase/config.toml`.
Riesgo residual actual: Medio-Alto — login es funcional hoy y la única mitigación real depende de configuración de desarrollo no confirmada para producción. Riesgo residual futuro: Alto si no se implementa rate limiting propio antes de producción. Momento: **antes de producción, obligatorio**.

**T-12 — Abuso de exportaciones (Excel)**
Activo: Excel generado (datos agregados de remuneración). Actor: usuario interno malicioso. Vector: generar exportaciones repetidas para exfiltrar datos masivamente. Impacto: fuga de datos de remuneración/asistencia. Probabilidad: N/A hoy. Severidad inherente: **Media-Alta**. Estado: `FUTURE_SURFACE` (`src/lib/excel/` sin código).
Implementadas: no aplica.
Pendientes: rate limiting específico por usuario, auditoría en `audit_log` — a implementar junto con la funcionalidad.
Evidencia: `src/lib/excel/README.md`.
Riesgo residual actual: N/A. Riesgo residual futuro: Medio-Alto si se implementa sin rate limiting ni auditoría. Momento: al implementar exportación Excel.

**T-13 — Carga maliciosa de archivos**
Activo: futuro bucket de Storage, integridad del sistema. Actor: usuario interno malicioso, atacante externo. Vector: subir un archivo con contenido malicioso o tipo MIME falsificado como documento de respaldo. Impacto: malware almacenado, XSS si se sirve sin `Content-Disposition` correcto, DoS por tamaño. Probabilidad: N/A hoy. Severidad inherente: **Alta**. Estado: `FUTURE_SURFACE` (Storage no implementado).
Implementadas: no aplica — la tabla `supporting_documents` es solo metadata, sin contenido de archivo.
Pendientes: validación de tipo MIME real, límite de tamaño, bucket privado con signed URLs de corta duración.
Evidencia: `20260817144623_supporting_documents.sql` (comentarios de columna).
Riesgo residual actual: N/A. Riesgo residual futuro: Alto si Storage se implementa sin las validaciones pendientes. Momento: al implementar upload real.

**T-14 — Malware en documentos adjuntos**
Activo: futuro bucket de Storage, dispositivos de quien descarga. Actor: usuario interno malicioso (subida deliberada), atacante externo (cuenta comprometida). Vector: archivo adjunto con payload malicioso. Impacto: propagación de malware. Probabilidad: N/A hoy. Severidad inherente: **Media**. Estado: `FUTURE_SURFACE`.
Implementadas: no aplica.
Pendientes: evaluar escaneo antivirus/antimalware en el pipeline de subida — decisión pendiente, no tomada en este gate.
Evidencia: `docs/DECISIONS_PENDING.md`.
Riesgo residual actual: N/A. Riesgo residual futuro: Medio, mitigable con escaneo si se decide implementarlo. Momento: al implementar upload real.

**T-15 — Documentos/payloads excesivamente grandes (DoS de recursos)**
Activo: disponibilidad del servicio, Storage. Actor: atacante externo, usuario interno malicioso. Vector: subir/enviar payloads muy grandes repetidamente. Impacto: agotamiento de recursos, costos. Probabilidad: N/A hoy (sin endpoints reales). Severidad inherente: **Media**. Estado: `FUTURE_SURFACE`.
Implementadas: `supabase/config.toml` `storage.file_size_limit = "50MiB"` — límite de plataforma del CLI local, no una decisión de producto confirmada.
Pendientes: límite de tamaño explícito por tipo de archivo a nivel de aplicación (`docs/API_SECURITY_STANDARD.md`, respuesta `413`).
Evidencia: `supabase/config.toml`.
Riesgo residual actual: N/A. Riesgo residual futuro: Medio si no se define un límite propio de aplicación. Momento: al implementar cualquier endpoint de upload.

**T-16 — PII en logs**
Activo: logs de aplicación. Actor: operador/desarrollador (acceso legítimo a logs), atacante externo (si los logs se filtran). Vector: registrar accidentalmente pathname con identificadores, tokens, claims, email o payloads completos. Impacto: exposición de datos personales fuera de la base de datos controlada por RLS. Probabilidad: Media (error común). Severidad inherente: **Alta**. Estado: `MITIGATED` (superficie activa — el guard ya loguea en cada request — con control verificado por test).
Implementadas: `middleware.ts` registra solo `{event, errorName}` en fallos, nunca pathname/query/cookies/token/claims/email (verificado por test dedicado con UUID ficticio); `src/lib/workera/logging.ts` usa una interfaz de campos fijos que hace estructuralmente imposible loguear un payload completo o una API key.
Pendientes: esta disciplina debe extenderse a cualquier logging futuro — cubierto como requisito obligatorio en `docs/API_SECURITY_STANDARD.md`.
Evidencia: `middleware.ts`, `middleware.test.ts`, `src/lib/workera/logging.ts`.
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo si se mantiene la misma disciplina en código nuevo; Medio si no se aplica el estándar consistentemente. Momento: continuo — gate de revisión en cada PR que agregue logging.

**T-17 — Pérdida de datos (accidental o por incidente)**
Activo: todos los datos de Postgres/Storage. Actor: operador/desarrollador (error), atacante externo (ataque destructivo), fallo de infraestructura. Vector: `DELETE`/`DROP` accidental, corrupción, fallo de hardware del proveedor. Impacto: pérdida irrecuperable de datos operativos **de producción**. Probabilidad: Baja pero con impacto crítico. Severidad inherente: **Crítica**. Estado: `FUTURE_SURFACE` — **no existe ningún proyecto de producción ni dato operativo real hoy**; los datos actuales son sintéticos (dev/CI) y se reconstruyen en cada `db reset`.
Implementadas: ninguna estrategia de backup — no aplica todavía porque no hay datos reales que perder.
Pendientes: ver `docs/BACKUP_RECOVERY_PLAN.md` íntegro — RPO/RTO propuestos, no aprobados; runbook de restauración `UNTESTED`.
Evidencia: `docs/BACKUP_RECOVERY_PLAN.md`; ausencia de cualquier proyecto Supabase remoto.
Riesgo residual actual: Bajo/N/A — no hay datos de producción que perder hoy. Riesgo residual futuro: **Alto** si se lanza producción sin resolver el plan de backup. Momento: **antes de producción, obligatorio** (bloqueador de lanzamiento, no una vulnerabilidad activa hoy).

**T-18 — Manipulación de auditoría**
Activo: `audit_log`. Actor: usuario interno malicioso, atacante con acceso de escritura comprometido. Vector: modificar o borrar un registro de auditoría para ocultar una acción. Impacto: pérdida de trazabilidad, imposibilidad de investigar un incidente. Probabilidad: Baja. Severidad inherente: **Alta**. Estado: `MITIGATED` (el control de inmutabilidad está activo) aunque la tabla está funcionalmente vacía (`NOT_APPLICABLE_CURRENTLY` en términos de haber algo real que manipular).
Implementadas: `audit_log` es append-only por diseño — trigger `enforce_immutable_columns()` sin columnas mutables, sin policy de `DELETE`; SELECT restringido a `is_admin_rrhh()`; test `020_audit_log_protection.sql`.
Pendientes: `audit_log` no se puebla automáticamente todavía — ninguna acción de negocio real escribe en ella porque no existen Route Handlers de escritura.
Evidencia: `20260817152542_rls_reviews_periods_exports_documents_audit.sql`, `supabase/tests/020_audit_log_protection.sql`.
Riesgo residual actual: Bajo (control activo, sin datos reales que atacar). Riesgo residual futuro: Bajo si se mantiene el mismo diseño al conectar escrituras reales. Momento: conectar `audit_log` a las primeras acciones de escritura reales.

**T-19 — Replay de requests**
Activo: acciones de escritura futuras (aprobaciones). Actor: atacante externo (interceptó una request válida). Vector: reenviar una request capturada. Impacto: acción duplicada no deseada. Probabilidad: Baja (HTTPS mitiga interceptación). Severidad inherente: **Media**. Estado: `FUTURE_SURFACE` (sin endpoints de escritura reales).
Implementadas: no aplica.
Pendientes: idempotencia explícita en Route Handlers de escritura — cubierto en `docs/API_SECURITY_STANDARD.md`.
Evidencia: N/A (sin endpoints reales).
Riesgo residual actual: N/A. Riesgo residual futuro: Medio si no se implementa idempotencia. Momento: al implementar Route Handlers de escritura.

**T-20 — Duplicación de sincronización (Workera → Supabase)**
Activo: `attendance_records`, `absence_records`, `sync_runs`. Actor: fallo técnico (reintento automático), no necesariamente malicioso. Vector: correr la sincronización dos veces sobre el mismo rango de fechas. Impacto: datos duplicados o inconsistentes. Probabilidad: Media (cuando exista sync real). Severidad inherente: **Media**. Estado: `BLOCKED_EXTERNAL` (la sync real está bloqueada por falta de documentación de Workera).
Implementadas: `UNIQUE(source, external_id) WHERE external_id IS NOT NULL` en `attendance_records`/`absence_records` — upsert idempotente ya en el esquema.
Pendientes: fallback para registros sin ID externo — a implementar junto con `HttpWorkeraClient`.
Evidencia: `docs/DATA_MODEL_PHASE2.md`.
Riesgo residual actual: N/A (sync no existe). Riesgo residual futuro: Bajo — el diseño ya contempla idempotencia antes de que la sync exista. Momento: al desbloquear Fase 5.

**T-21 — Cierre mensual incorrecto (integridad de negocio, no solo seguridad)**
Activo: `reporting_periods`, `weekly_reviews`, remuneraciones derivadas. Actor: usuario interno (error), `ADMIN_RRHH`. Vector: cerrar un período con revisiones semanales pendientes o datos incompletos. Impacto: cálculo de remuneración incorrecto. Probabilidad: Media. Severidad inherente: **Alta** (impacto de negocio). Estado: `FUTURE_SURFACE` (no existe ningún flujo de UI/API que permita cerrar un período todavía).
Implementadas: enums de estado y `EXCLUDE USING gist` anti-solapamiento de períodos.
Pendientes: el bloqueo de "no cerrar con revisiones pendientes" está documentado, no implementado como trigger de base de datos (`docs/DATA_MODEL_PHASE2B.md` sección 24) — gap de diseño real que persistirá si no se cierra antes de construir el flujo.
Evidencia: `docs/DATA_MODEL_PHASE2B.md`.
Riesgo residual actual: N/A (sin flujo que ejecutar). Riesgo residual futuro: Medio-Alto si el flujo de cierre se construye sin agregar el trigger. Momento: antes de habilitar el flujo de cierre mensual en UI/API.

**T-22 — Supply-chain de GitHub Actions**
Activo: pipeline de CI, integridad del código que llega a producción. Actor: atacante externo (compromiso de una Action de terceros), operador (error al agregar una Action no verificada). Vector: una Action maliciosa o comprometida ejecuta código arbitrario en el runner. Impacto: exfiltración de secretos del runner, modificación silenciosa del build. Probabilidad: Baja pero con precedentes conocidos en el ecosistema. Severidad inherente: **Alta**. Estado: `MITIGATED` (CI está activo hoy, con control verificado).
Implementadas: las 3 Actions usadas están fijadas a SHA de commit completo, verificadas contra la API pública de GitHub; `permissions: contents: read` en workflow y jobs; sin `pull_request_target`; sin secretos en el workflow.
Pendientes: sin renovación automática de SHAs; sin dependency review automatizado de `package.json`.
Evidencia: `.github/workflows/ci.yml`.
Riesgo residual actual: Bajo. Riesgo residual futuro: Bajo si se mantiene la disciplina de pinning al actualizar Actions. Momento: revisar periódicamente.

**T-23 — Dependencia externa Workera (disponibilidad e integridad de datos)**
Activo: todo el flujo de asistencia. Actor: N/A (dependencia externa). Vector: Workera cambia su API sin aviso, tiene downtime, o entrega datos incorrectos. Impacto: sincronización rota o datos de asistencia incorrectos. Probabilidad: Desconocida. Severidad inherente: **Alta** para el negocio. Estado: `BLOCKED_EXTERNAL` — activo como bloqueador de avance, no como vulnerabilidad explotable.
Implementadas: modelo interno normalizado desacopla el resto de la app de la forma exacta de la API de Workera; errores tipados retryable/no-retryable ya diseñados.
Pendientes: todo — depende de documentación oficial o confirmación escrita de Workera.
Evidencia: `docs/WORKERA_PHASE5C_BLOCKED.md`.
Riesgo residual actual: Alto como riesgo de negocio (bloquea el roadmap), no como vulnerabilidad de seguridad activa. Riesgo residual futuro: Alto mientras persista el bloqueo. Momento: bloqueado indefinidamente hasta obtener documentación.

**T-24 — Caída de servicios (disponibilidad)**
Activo: disponibilidad de la app. Actor: N/A (infraestructura). Vector: caída de Supabase, Vercel (futuro), o Workera. Impacto: interrupción del servicio. Probabilidad: Baja-Media. Severidad inherente: **Media**. Estado: `NOT_APPLICABLE_CURRENTLY` (no existe infraestructura de producción).
Implementadas: no aplica.
Pendientes: a definir cuando exista plan de despliegue real (fuera del alcance de este gate, documental).
Evidencia: N/A.
Riesgo residual actual: N/A. Riesgo residual futuro: Medio, depende del diseño de despliegue elegido. Momento: al definir arquitectura de despliegue de producción.

**T-25 — Insider threat (supervisor o admin abusando de acceso legítimo)**
Activo: todos los datos accesibles por el rol del actor. Actor: usuario interno malicioso (supervisor o `ADMIN_RRHH` con cuenta legítima). Vector: uso del propio acceso autorizado para fines no autorizados. Impacto: fuga de datos, mal uso de información de trabajadores. Probabilidad: Baja pero no descartable. Severidad inherente: **Alta**. Estado: `ACTIVE` (cuentas y roles reales ya pueden existir hoy, aunque sin UI de datos que explotar todavía en la práctica).
Implementadas: RLS limita el alcance de cada rol; infraestructura de `audit_log` existe para trazabilidad futura, aunque hoy no registra nada (ver T-18).
Pendientes: alertas sobre patrones de acceso anómalo — no diseñado todavía, depende de que exista la funcionalidad de exportación.
Evidencia: matriz de permisos en `docs/SECURITY_PHASE3.md`.
Riesgo residual actual: Medio — mitigado por scope de RLS, pero sin detección de abuso, y sin superficie de datos real que un insider pudiera abusar todavía (no hay UI). Riesgo residual futuro: Medio-Alto cuando exista UI/exportación sin detección de abuso. Momento: al implementar exportaciones/acciones sensibles, junto con auditoría real.

## 5. Resumen — tres dimensiones, sin mezclar

### 5.1 Por severidad inherente (impacto si no hubiera ninguna mitigación)

| Severidad inherente | Cantidad | IDs |
|---|---|---|
| Crítica | 5 | T-04, T-05, T-06, T-07, T-17 |
| Alta | 13 | T-01, T-02, T-03, T-09, T-10, T-13, T-16, T-18, T-21, T-22, T-23, T-25, T-11 |
| Media | 7 | T-08, T-12, T-14, T-15, T-19, T-20, T-24 |

### 5.2 Por riesgo residual **actual** (con las mitigaciones ya implementadas hoy, y considerando si la superficie existe)

| Riesgo residual actual | Cantidad | IDs |
|---|---|---|
| Crítico | 0 | — |
| Alto | 1 | T-23 (riesgo de negocio/roadmap, no vulnerabilidad de seguridad explotable) |
| Medio-Alto | 1 | T-11 |
| Medio | 2 | T-01, T-25 |
| Bajo | 10 | T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-16, T-18, T-22 |
| N/A (sin superficie hoy) | 11 | T-09, T-10, T-12, T-13, T-14, T-15, T-17, T-19, T-20, T-21, T-24 |

**Conclusión explícita requerida:** con la evidencia disponible en el repositorio a la fecha de este gate, **no existe ninguna vulnerabilidad crítica activa confirmada hoy**. Las 5 amenazas de severidad inherente Crítica (T-04, T-05, T-06, T-07, T-17) están todas en estado `MITIGATED` (T-04, T-05, T-06, T-07, controles verificados por test) o `FUTURE_SURFACE` (T-17, no hay datos de producción que perder todavía). El hallazgo de mayor riesgo residual **actual** es T-11 (brute force de login, Medio-Alto) — real pero no crítico, y con causa raíz clara (falta de rate limiting propio) ya documentada como bloqueador antes de producción.

### 5.3 Por riesgo residual **futuro** (si las mitigaciones pendientes no se implementan antes de que cada superficie se active)

| Riesgo residual futuro | Cantidad | IDs |
|---|---|---|
| Alto | 6 | T-10, T-11, T-13, T-17, T-21, T-23 |
| Medio-Alto | 2 | T-12, T-25 |
| Medio | 9 | T-01, T-03, T-06, T-09, T-14, T-15, T-19, T-24, T-16 |
| Bajo | 8 | T-02, T-04, T-05, T-07, T-08, T-18, T-20, T-22 |

Esta tabla es la que debe guiar el orden de trabajo de los próximos gates de seguridad: T-11 y T-17 ya están marcados como bloqueadores obligatorios antes de producción (Gate C ya generó sus planes — `docs/ABUSE_RATE_LIMITING_PLAN.md`, `docs/BACKUP_RECOVERY_PLAN.md`); T-10, T-13, T-21, T-23 deben resolverse en el momento exacto en que se construya la superficie correspondiente (HTTP client, Storage, cierre mensual, Workera real respectivamente), no antes ni después.

## 6. Controles ya implementados vs. pendientes (resumen ejecutivo)

**Implementados y verificados (`MITIGATED`):** RLS deny-by-default (34/34 tablas), roles con anti-escalación, verificación criptográfica de JWT vía `getClaims()` con fail-closed, adapter Workera con secretos aislados server-only, CI con Actions pinneadas y permisos mínimos, inmutabilidad de `audit_log` y tablas de hechos, logging sin PII en el guard de sesión.

**Activos sin mitigación suficiente (`ACTIVE`, riesgo residual actual real):** T-11 (brute force de login), T-01 (atributos de cookie sin auditar contra dominio real), T-25 (insider threat sin detección de abuso, aunque scoped por RLS).

**Superficie futura, sin vulnerabilidad hoy (`FUTURE_SURFACE`):** todo lo relacionado a UI de datos, Route Handlers, Storage, Excel, cierre mensual — el riesgo se activa cuando se construya, no antes.

**Bloqueados por dependencia externa (`BLOCKED_EXTERNAL`):** todo lo relacionado a Workera real (T-20, T-23).
