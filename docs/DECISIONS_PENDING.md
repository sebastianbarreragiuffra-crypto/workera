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

- `[USUARIO/PRODUCTO]` **Colación en la planilla de asistencia de RRHH**: el
  archivo real muestra `Colación: 40 minutos` bajo el horario, pero el esquema no
  almacena la duración ni define si depende de empresa, horario o trabajador.
  RRHH debe confirmar el origen y si afecta fórmulas de jornada antes de la marcha
  blanca. No hardcodear 40 minutos ni inferirlo desde el texto del horario.
- `[USUARIO/PRODUCTO]` **Ciclo exacto de cierre mensual** (`ReportingPeriod`): duración/fecha de corte no confirmada. Gate D solo agregó que la recomputación del bono respeta `status='CLOSED'` (falla en vez de mutar) — el ciclo en sí sigue sin definir.
- `[TÉCNICA]` **Bloqueo de cierre con revisiones semanales pendientes**: hoy es solo documentado (`docs/DATA_MODEL_PHASE2B.md` sección 24), no un trigger de base de datos — decisión técnica pendiente: ¿implementarlo como constraint duro o dejarlo como validación de aplicación? (Ver `docs/THREAT_MODEL.md` T-21.) No resuelto por Gate D.

## Seguridad y operación

- `[USUARIO/PRODUCTO]` + `[TÉCNICA]` **Límites de rate limiting restantes**: Rendiciones ya tiene límites iniciales conservadores y ajustables documentados en `docs/ABUSE_RATE_LIMITING_PLAN.md`; faltan números finales para login, recuperación, superficies laborales, aprobaciones y acciones administrativas. Calibrarlos con métricas de marcha blanca antes de declararlos definitivos.
- `[TÉCNICA]` **MFA — DECIDIDO e IMPLEMENTADO** en la rama `feat/mfa-totp`. El diseño completo es [docs/MFA_DESIGN.md](MFA_DESIGN.md) y la operación es [docs/PLATFORM_OWNER_RUNBOOK.md](PLATFORM_OWNER_RUNBOOK.md). Resumen de lo construido: segundo factor TOTP con el MFA nativo de Supabase Auth; regla de quién lo exige derivada del rol en `account_requires_mfa()`, extensible a `SUPERVISOR_*` editando una sola función; bloqueo inmediato detrás de `MFA_ENFORCEMENT_ENABLED`; doble capa, con guarda `aal2` también dentro de los RPC sensibles; y bitácora append-only `mfa_events`. Dos puntos de la versión anterior de esta entrada quedaron corregidos por el diseño y se dejan anotados para que nadie los reintroduzca:
  - **No hay códigos de respaldo.** Supabase Auth no ofrece códigos de un solo uso. El OWNER necesita un factor TOTP y recibe la recomendación explícita de inscribir un segundo secreto guardado físicamente; si no lo hace, la recuperación depende del break-glass.
  - **El reseteo es global y no se delega al tenant.** Solo el OWNER de plataforma resetea a otra persona; un admin de empresa no puede borrar factores que también protegen accesos a otros tenants. La cuenta OWNER no se resetea desde la aplicación. Todo intento queda auditado antes de modificar Auth.
- `[TÉCNICA]` **Aviso por correo al reiniciar el MFA de otra persona**: pendiente de infraestructura, no de decisión. El diseño lo pide, pero el proyecto no tiene envío transaccional (lo único disponible es `inviteUserByEmail` de Supabase Auth, y el SMTP está comentado en `config.toml`). Siguiendo el criterio ya vigente para invitaciones, no se simula un envío: el reseteo queda registrado en `mfa_events` y la pantalla pide avisar a la persona manualmente. Se resuelve cuando exista un proveedor de correo configurado.
- `[USUARIO/PRODUCTO]` **Identidad de la cuenta de administración de plataforma** (conversación de septiembre 2026): decisión provisional del usuario — usar su Gmail personal (`sbarreragiuffra@gmail.com`) endurecido (2FA con app de autenticación, **quitar** teléfono/SMS como método y como recuperación, correo de recuperación a una dirección aparte, códigos de respaldo impresos y en lugar físico seguro conocido por una persona de confianza). **Riesgo aceptado conscientemente:** un Gmail personal de uso general tiene amplia superficie de recuperación (= superficie de robo de cuenta) y no es un activo del negocio recuperable a nivel organización. **Gate de migración obligatorio:** antes de activar el primer cliente distinto de ARCOTEX, esta cuenta debe pasar a un dominio del producto controlado (p. ej. `admin@<producto>.cl`), dedicada, sin uso personal. No usar un correo `@arcotex.cl` para esto — mezcla la identidad de la plataforma con la de un cliente.
- `[USUARIO/PRODUCTO]` + `[TÉCNICA]` **Procedimiento break-glass de la cuenta OWNER — RESUELTO**, documentado en [docs/PLATFORM_OWNER_RUNBOOK.md](PLATFORM_OWNER_RUNBOOK.md). Un factor TOTP es obligatorio y un segundo secreto impreso es la recomendación de recuperación; el borrado de `auth.mfa_factors` desde el panel de Supabase queda como última opción. `can_reset_mfa_for()` excluye explícitamente a toda cuenta OWNER activa, incluso para otro OWNER: si la aplicación pudiera reiniciar el factor del administrador de la plataforma, ese camino sería el eslabón más débil del esquema. Sigue pendiente lo que ya estaba pendiente antes y es de negocio: si se quiere una **segunda cuenta OWNER** con credenciales selladas, para no depender de una sola persona.
- `[TÉCNICA]` **Comportamiento del rate limiter restante ante su propia caída**: Rendiciones financiera ya falla cerrada; falta decidir login, borde y superficies laborales según disponibilidad/riesgo.
- `[USUARIO/PRODUCTO]` **Proveedor antivirus/antimalware y retención de rechazados**: la frontera técnica de cuarentena ya está implementada (`docs/EXPENSE_FILE_QUARANTINE.md`), pero el motor/servicio real, costo, SLA, región, CDR y plazo de conservación siguen sin decidir. Correo y WhatsApp deben permanecer apagados hasta cerrar esa elección y sus canarios.
- `[TÉCNICA]` **Límites de tamaño de archivo** por tipo de documento: `TBD` en `docs/API_SECURITY_STANDARD.md`/`docs/THREAT_MODEL.md` T-15.

## Backups e infraestructura

- `[USUARIO/PRODUCTO]` **Plan Supabase a contratar** (hosted, staging/producción): no existe todavía — determina qué capacidades reales de backup/PITR/rate limiting hosted están disponibles (verificado en este gate: el plan Free no incluye backups automáticos). Toda la sección 4 de `docs/BACKUP_RECOVERY_PLAN.md` depende de esto — es una decisión de presupuesto, no solo técnica.
- `[USUARIO/PRODUCTO]` **RPO/RTO de producción**: propuestos (1h/4h) en `docs/BACKUP_RECOVERY_PLAN.md`, no aprobados — un RPO de 1h exige contratar PITR explícitamente (no disponible en Free).
- `[USUARIO/PRODUCTO]` **Retención de backups**: propuesta 30 días, no confirmada; posible alineación con obligaciones legales chilenas sobre datos de remuneración — fuera del alcance técnico de este gate.
- `[TÉCNICA]` **Separación de responsabilidades operacional** (quién administra backups vs. quién es `ADMIN_RRHH` de la app): propuesta, no formalizada (no hay equipo de operaciones definido todavía).
- `[DEPENDENCIA EXTERNA]` **Documentación oficial de Workera**: bloqueo externo activo desde Fase 5 (3 fases consecutivas bloqueadas: 5, 5B, 5C) — requiere documentación oficial (OpenAPI/Swagger/PDF/Postman) o confirmación escrita de quien administra la relación técnica con Workera, especificando mecanismo de autenticación exacto, Base URL completa, y al menos un endpoint de lectura confirmado. Fuera del control del equipo técnico.

## Notas de proceso

Cada vez que uno de estos puntos se resuelva, la resolución debe documentarse en el archivo correspondiente (`BUSINESS_RULES_*`, `THREAT_MODEL.md`, `ABUSE_RATE_LIMITING_PLAN.md`, `BACKUP_RECOVERY_PLAN.md`) y eliminarse de esta lista — este documento debe reflejar únicamente lo que sigue sin decidir en el momento en que se lee.
