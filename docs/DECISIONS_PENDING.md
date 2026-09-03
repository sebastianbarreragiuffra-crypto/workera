# Decisiones Pendientes — consolidado

Estado: creado en Gate C pre-UI. Este documento consolida decisiones de negocio/seguridad/infraestructura que requieren confirmación humana futura, ya mencionadas de forma dispersa en otros documentos. **Ninguna se decide en este gate** — este gate es exclusivamente documental.

**Leyenda de categoría** (agregada en el hardening de este gate, para no mezclar quién debe resolver cada punto):
- `[USUARIO/PRODUCTO]` — requiere una decisión de negocio de Sebastián/Arcotex; nadie más puede resolverla.
- `[DEPENDENCIA EXTERNA]` — requiere información o acción de un tercero (Workera, Supabase) fuera del control del equipo.
- `[TÉCNICA]` — requiere una decisión de diseño/implementación que el equipo técnico puede resolver una vez tenga contexto suficiente, sin depender de un tercero.

## Reglas de negocio — RESUELTAS en Gate D (20260818160000 + 20260818170000)

Confirmadas por el usuario e implementadas a nivel de base de datos, verificadas con 93 pruebas pgTAP nuevas (44 + 49, 212/212 totales) + evidencia real de concurrencia (7 escenarios con dos sesiones PostgreSQL en total entre ambas pasadas). Detalle completo en `docs/BUSINESS_RULES_GATE_D.md`. **Recordatorio obligatorio: son políticas internas, pendientes de validación por RR. HH./legal antes de producción — no una declaración de cumplimiento legal.**

- ~~Horas extra de viernes para Producción~~ → 120 min, igual que lunes-jueves.
- ~~Determinación HH50 vs. HH100~~ → lunes-sábado sin feriado = HH50; domingo o feriado (cualquier día) = HH100.
- ~~Código de estado `R`~~ → desactivado (`active=false`), preservado por compatibilidad histórica, bloqueado para asignaciones nuevas (INSERT y UPDATE/upsert, verificado en el segundo hardening).
- ~~Horas extra de Instalación~~ → sin tope fijo automático, autoridad exacta del supervisor asignado (`SUPERVISOR_INSTALLATION`, rol ya existente), minutos exactos, nunca reducida al selector binario.
- ~~Bono de Instalación~~ → mismo esquema que Producción (120 min aprobados = $1.000 CLP).
- ~~Fines de semana de Instalación~~ → según demanda, sin tope fijo (cubierto por la regla general de Instalación arriba).
- ~~Selector 1h/2h de Producción~~ → exclusivo Producción lunes-viernes HH50, matriz exacta de minutos (< 60 sin propuesta, 60-114 → 60, 115-117 → 60 con revisión obligatoria, 118-120 → 120, > 120 → tope 120), autorizado exclusivamente por Jefe de Producción (`SUPERVISOR_PRODUCTION`, sobre su grupo) y RR. HH. (`ADMIN_RRHH`), vía la RLS ya existente de `overtime_decisions`.
- ~~Marcaciones faltantes~~ → red flag automática (`MISSING_CLOCK_IN`/`_CLOCK_OUT`/`_BOTH`), bloquea aprobación de horas extra hasta corregirse, resoluble solo por RRHH/jefe correspondiente.
- ~~Correcciones de marcación~~ → se reutiliza `attendance_corrections` (Fase 3), reforzada con rol del autor, tipo de corrección, validaciones de zona horaria de Chile, bloqueo en período cerrado, y bloqueo por conflicto con una decisión de horas extra activa. El dato crudo de Workera nunca se sobrescribe.

## Reglas de negocio — todavía pendientes

- `[USUARIO/PRODUCTO]` **Ciclo exacto de cierre mensual** (`ReportingPeriod`): duración/fecha de corte no confirmada. Gate D solo agregó que la recomputación del bono respeta `status='CLOSED'` (falla en vez de mutar) — el ciclo en sí sigue sin definir.
- `[TÉCNICA]` **Bloqueo de cierre con revisiones semanales pendientes**: hoy es solo documentado (`docs/DATA_MODEL_PHASE2B.md` sección 24), no un trigger de base de datos — decisión técnica pendiente: ¿implementarlo como constraint duro o dejarlo como validación de aplicación? (Ver `docs/THREAT_MODEL.md` T-21.) No resuelto por Gate D.

## Seguridad y operación

- `[USUARIO/PRODUCTO]` + `[TÉCNICA]` **Límites de rate limiting** (todos los valores `TBD` en `docs/ABUSE_RATE_LIMITING_PLAN.md`): login, recuperación de contraseña, futuras APIs, aprobaciones, exportación Excel, upload de documentos, acciones administrativas — los números finales son decisión de producto, el mecanismo es decisión técnica.
- `[TÉCNICA]` **MFA — completamente DECIDIDO, solo falta implementar** (conversación de septiembre 2026):
  - Segundo factor **TOTP** (app de autenticación, nunca SMS), usando el MFA nativo de Supabase Auth (`supabase.auth.mfa.*` + claim `aal` en el JWT). No implementar TOTP a mano.
  - **Obligatorio para:** el gerente, las 2 cuentas `ADMIN_RRHH` que aprueban licencias, y la cuenta de administración de plataforma (OWNER). Los roles `SUPERVISOR_*` quedan fuera por ahora, pero el gate debe ser configurable (helper tipo `profileRequiresMfa(profile)`), no una lista fija — los supervisores toman decisiones de atraso/HH que afectan liquidación, la extensión futura no debe implicar refactor.
  - **Despliegue: bloqueo inmediato.** No hay plazo de gracia — desde el despliegue del flag de enforcement, ninguna cuenta privilegiada entra sin MFA inscrito; solo alcanza la pantalla de inscripción. Implica un **despliegue en dos pasos**: primero la pantalla de inscripción disponible sin enforcement, se inscriben y verifican todas las cuentas privilegiadas (la del OWNER primero, con sus códigos de respaldo ya guardados), y recién entonces se activa el enforcement. Nunca existe una ventana donde una cuenta privilegiada funcione sin MFA.
  - **Reseteo del MFA de otra persona: solo la cuenta OWNER.** Los `ADMIN_RRHH` no se resetean entre sí ni a supervisores. La cuenta OWNER **no tiene reseteo**: su recuperación son los códigos de respaldo impresos (break-glass, ver punto siguiente). Todo reseteo queda auditado.
  - Prompt de implementación completo entregado para Codex (rama `feat/mfa-totp`, Supabase de worktree aislado).
- `[USUARIO/PRODUCTO]` **Identidad de la cuenta de administración de plataforma** (conversación de septiembre 2026): decisión provisional del usuario — usar su Gmail personal (`sbarreragiuffra@gmail.com`) endurecido (2FA con app de autenticación, **quitar** teléfono/SMS como método y como recuperación, correo de recuperación a una dirección aparte, códigos de respaldo impresos y en lugar físico seguro conocido por una persona de confianza). **Riesgo aceptado conscientemente:** un Gmail personal de uso general tiene amplia superficie de recuperación (= superficie de robo de cuenta) y no es un activo del negocio recuperable a nivel organización. **Gate de migración obligatorio:** antes de activar el primer cliente distinto de ARCOTEX, esta cuenta debe pasar a un dominio del producto controlado (p. ej. `admin@<producto>.cl`), dedicada, sin uso personal. No usar un correo `@arcotex.cl` para esto — mezcla la identidad de la plataforma con la de un cliente.
- `[USUARIO/PRODUCTO]` + `[TÉCNICA]` **Procedimiento break-glass de la cuenta OWNER**: hoy no existe. Si el único OWNER pierde contraseña + dispositivo TOTP, la plataforma queda sin administrador. Falta definir: segunda cuenta OWNER con credenciales selladas físicamente, o ruta de recuperación documentada a nivel del panel de Supabase. La protección de "último OWNER activo" ya existe en base pero no cubre la pérdida de acceso.
- `[TÉCNICA]` **Comportamiento del rate limiter ante su propia caída**: fail-open vs. fail-closed por tipo de operación — propuesta en `docs/ABUSE_RATE_LIMITING_PLAN.md`, no confirmada.
- `[USUARIO/PRODUCTO]` **Escaneo antivirus/antimalware de documentos subidos** (cuando exista Storage): no evaluado, no decidido (`docs/THREAT_MODEL.md` T-14) — implica costo/proveedor adicional, decisión de producto.
- `[TÉCNICA]` **Límites de tamaño de archivo** por tipo de documento: `TBD` en `docs/API_SECURITY_STANDARD.md`/`docs/THREAT_MODEL.md` T-15.

## Backups e infraestructura

- `[USUARIO/PRODUCTO]` **Plan Supabase a contratar** (hosted, staging/producción): no existe todavía — determina qué capacidades reales de backup/PITR/rate limiting hosted están disponibles (verificado en este gate: el plan Free no incluye backups automáticos). Toda la sección 4 de `docs/BACKUP_RECOVERY_PLAN.md` depende de esto — es una decisión de presupuesto, no solo técnica.
- `[USUARIO/PRODUCTO]` **RPO/RTO de producción**: propuestos (1h/4h) en `docs/BACKUP_RECOVERY_PLAN.md`, no aprobados — un RPO de 1h exige contratar PITR explícitamente (no disponible en Free).
- `[USUARIO/PRODUCTO]` **Retención de backups**: propuesta 30 días, no confirmada; posible alineación con obligaciones legales chilenas sobre datos de remuneración — fuera del alcance técnico de este gate.
- `[TÉCNICA]` **Separación de responsabilidades operacional** (quién administra backups vs. quién es `ADMIN_RRHH` de la app): propuesta, no formalizada (no hay equipo de operaciones definido todavía).
- `[DEPENDENCIA EXTERNA]` **Documentación oficial de Workera**: bloqueo externo activo desde Fase 5 (3 fases consecutivas bloqueadas: 5, 5B, 5C) — requiere documentación oficial (OpenAPI/Swagger/PDF/Postman) o confirmación escrita de quien administra la relación técnica con Workera, especificando mecanismo de autenticación exacto, Base URL completa, y al menos un endpoint de lectura confirmado. Fuera del control del equipo técnico.

## Notas de proceso

Cada vez que uno de estos puntos se resuelva, la resolución debe documentarse en el archivo correspondiente (`BUSINESS_RULES_*`, `THREAT_MODEL.md`, `ABUSE_RATE_LIMITING_PLAN.md`, `BACKUP_RECOVERY_PLAN.md`) y eliminarse de esta lista — este documento debe reflejar únicamente lo que sigue sin decidir en el momento en que se lee.
