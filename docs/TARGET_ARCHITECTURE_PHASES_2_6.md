# Arquitectura objetivo de GESTORA — Fases 2 a 6

Estado al 4 de septiembre de 2026. Este documento describe el estado vigente de
la rama `codex/phases2-6-autonomous` y la arquitectura objetivo para llevar
GESTORA desde marcha blanca a una plataforma multiempresa operable. No implica
que `master`, staging o producción contengan estos cambios.

`ARCHITECTURE.md` se conserva como documento histórico de la etapa Workera
pre-UI. Para decisiones nuevas, este documento y `docs/PLATFORM_MULTI_COMPANY.md`
son la referencia principal.

## 1. Dictamen del comité

### Arquitecto de software y sistemas distribuidos

GESTORA debe continuar como un **monolito modular desplegable** sobre Next.js,
Supabase Auth, Postgres y Storage. Separar hoy cada módulo en microservicios
añadiría latencia, coordinación distribuida, observabilidad y costo operativo
sin una carga que lo justifique.

La arquitectura debe **prepararse para una extracción**, pero esa capacidad aún
no está demostrada: cada integración externa vive detrás de un adaptador
server-only y los trabajos asíncronos usan inbox/outbox durable, idempotencia,
leases y fencing, pero todavía existen lecturas directas del shared kernel y no
hay tests automáticos de límites de módulo. El primer componente que eventualmente
conviene extraer no es una pantalla de negocio, sino el plano de integraciones y
workers cuando su volumen o disponibilidad difieran del tráfico web.

### CISO / DevSecOps

La frontera de seguridad correcta es defensa en profundidad: sesión verificada,
autorización server-side, RLS deny-by-default, funciones privilegiadas con
`search_path = ''`, mínimo privilegio, secretos solo en servidor, archivos
privados y auditoría. Las revisiones Bugbot/Security de cada bloque quedaron
limpias después de corregir sus hallazgos **dentro de ese alcance de código**;
no sustituyen un modelo de amenazas vigente, un pentest ni evidencia operacional.

El sistema **no está aprobado para staging con PII ni para producción**. El
staging existente contiene 97 registros de empleados cuya anonimización no está
demostrada. El código MFA/AAL2 ya está integrado y probado localmente, pero aún
faltan inscripción y activación hospedadas, controles de abuso, prueba real de
backup y restauración DB+Storage, antimalware, reducción del blast radius de `service_role`,
aislamiento laboral para una segunda empresa, observabilidad, incident response,
revisión legal y canarios. Estos son bloqueos, no mejoras opcionales.

### Arquitecto de innovación y plataformas AI

Las decisiones financieras y laborales deben seguir siendo deterministas. La IA
puede explicar, clasificar o proponer un borrador, pero no aprobar, pagar,
conciliar, contabilizar ni cambiar una marcación. La Fase 6 aplica este principio:
preguntas allowlisted, cálculo SQL reproducible, datos minimizados, citas y cero
herramientas de escritura.

Para este repositorio brownfield, regulado y con RLS compleja, el agente principal
debe trabajar directamente sobre Git con tests y revisión humana. Generadores de
aplicaciones son útiles para prototipos aislados de UX, no como autoridad sobre
migraciones, permisos, nómina o contabilidad.

## 2. Estado entregado de las Fases 2–6

### Fase 2 — captura segura de comprobantes

- Captura web y desde cámara/fototeca mediante una interfaz responsive.
- Bandeja durable por empresa y persona, con estado visible para RR. HH./Finanzas.
- Ingesta por correo y WhatsApp detrás de flags deshabilitados por defecto.
- Firma de webhooks, límites de cuerpo/archivo, MIME más firma binaria, Storage
  privado, cuotas, idempotencia, leases y tokens de fencing.
- El número de WhatsApp se representa mediante HMAC; no se persiste el número
  real. La vinculación es de un solo uso, revocable y con vencimiento.

### Fase 3 — conciliación bancaria

- Importación tenant-aware y contratos estrictos para movimientos bancarios.
- Matching determinista, sin permitir que una coincidencia sugerida se convierta
  automáticamente en pago.
- Separación entre sugerencia, decisión humana y registro final.
- Datos bancarios restringidos al permiso `expenses.reconcile` o gestión.

### Fase 4 — salida contable durable

- Outbox transaccional con snapshot mínimo, hash e idempotency key.
- Reclamo concurrente mediante `FOR UPDATE SKIP LOCKED`.
- Reintentos acotados por allowlist (`RATE_LIMIT`), leases recuperables y
  estados explícitos; timeout/red/códigos nuevos quedan en reconciliación humana.
- Run ledger con exclusión de scheduler, fencing, catch-up acotado y watchdog.
- DLQ visible con replay maker-checker, confirmación externa o cancelación
  auditada; nunca se interpreta un timeout como éxito o fracaso financiero.
- Adaptador de proveedor deshabilitado hasta configurar un ERP real; la IA no
  decide cuentas, impuestos ni centros de costo.

### Fase 5 — experiencia móvil sin aplicación nativa

- PWA instalable desde Safari/Chrome, con manifest y orientación al usuario.
- Service worker privacy-safe: solo cachea assets públicos e inmutables.
- Nunca guarda HTML autenticado, APIs, comprobantes, documentos, exportaciones
  ni PII. Navegaciones siempre priorizan red y usan una pantalla offline pública.
- Fallos de Cache Storage no bloquean una respuesta válida de red.

### Fase 6 — asistente operacional reproducible

- Tres preguntas predefinidas: trabajo pendiente, gasto aprobado/pagado y estado
  de pago/contabilidad; ventanas de 7, 30 y 90 días.
- Respuesta determinista en Postgres, esquema Zod estricto, hasta 12 referencias
  y hash SHA-256. No existe prompt ni conversación libre.
- `PAYMENT_STATUS` exige conciliación/gestión; alertas y gasto exigen lectura,
  aprobación o gestión. Los permisos se aplican en UI, aplicación, RPC y RLS.
- El conciliador puro ve referencias, no enlaces 404 a detalles que no puede leer.
- Cuota de 30 consultas por persona/empresa/hora y purga global diaria a los 90
  días, autenticada dos veces y ejecutada por un límite service-role server-only.
- El hash detecta cambios accidentales del registro; no es firma, procedencia ni
  evidencia inmutable. Las 12 referencias son una muestra operativa, no un
  manifiesto de auditoría exhaustivo. Antes de usar la respuesta como evidencia
  financiera se requiere versionar cálculo, instante, zona horaria, redondeo y
  paginar el manifiesto completo.

## 3. Arquitectura lógica vigente

GESTORA opera en dos planos:

1. **Plano de control de plataforma.** Administra empresas, módulos, estados del
   workspace, invitaciones y membresías. Nunca debe ejecutar reglas laborales o
   financieras de un tenant implícito.
2. **Plano de workspace.** Resuelve una empresa activa y aplica sus permisos a
   asistencia, nómina, licencias, documentos, colaciones y Rendiciones.

El recorrido sincrónico es:

`Navegador/PWA → Next.js Proxy → Supabase Auth → Server Component/Action/Route → Postgres con RLS y/o Storage privado`.

Los recorridos asíncronos implementados en código son:

- `Resend/Meta → webhook firmado → ledger de captura → descarga validada → Storage → bandeja`.
- `Workera → adaptador server-only → sync_runs/eventos versionados → motor de reglas → revisión humana`.
- `Vercel Cron → ruta con CRON_SECRET → worker OCR/retención/contabilidad/watchdog`.
- `Pago aprobado → outbox contable → adaptador ERP → aceptación o reintento`.

El worker y su watchdog están programados diariamente en `vercel.json`, cadencia
compatible con Hobby. El heartbeat se calcula solo con ejecuciones `CRON` y usa
una ventana de 26 horas; ejecuciones manuales no pueden ocultar un scheduler
detenido. Cada salida tiene timeout, señal de cancelación y reserva de cierre, y
la DLQ fallida se pagina por separado. El run ledger, catch-up y resolución
terminal están implementados y probados localmente. Antes de un piloto deben
activarse en el ambiente, elegir una cadencia coherente con el SLO, conectar
alertas externas y probar el runbook contra el ERP; dos cron del mismo proveedor
no constituyen un watchdog independiente.
La pausa por empresa y su ciclo de vida se aplican en el claim de PostgreSQL. El
watchdog sigue leyendo salud con el kill-switch global apagado y la UI separa un
backlog retenido intencionalmente de una recuperación técnica.

### Límites de módulo y shared kernel

- Control plane es dueño de `companies`, catálogo de módulos, invitaciones y
  membresías; ningún módulo operativo escribe esas tablas directamente.
- Identidad/organización (`profiles`, roles, unidades) es shared kernel. Los
  módulos pueden referenciar IDs y leer contratos explícitos, no copiar ni
  reinterpretar la autorización.
- Asistencia/Workera es dueño de empleados, eventos y registros derivados;
  Rendiciones es dueño de `expense_*` y solo referencia identidad/empresa.
- Una escritura entre dominios debe cruzar un RPC/use case declarado. Las
  lecturas agregadas entre dominios deben migrar a read models o vistas
  versionadas antes de extraer un servicio.
- Falta un test de dependencias/ownership que haga estas reglas ejecutables; por
  eso la extraibilidad es objetivo arquitectónico y no una garantía actual.

## 4. Reglas de diseño obligatorias

### Tenant explícito

- Toda tabla operativa nueva lleva `company_id` no nulo.
- Toda relación sensible debe impedir cruces de empresa mediante FK o validación
  equivalente; no basta con filtrar en la interfaz.
- Todo job, RPC, importación, exportación, objeto de Storage e idempotency key
  incluye la empresa explícitamente.
- Cada superficie nueva incorpora pruebas negativas de cruce tenant en pgTAP y
  en la capa de aplicación.

### Consistencia y concurrencia

- Escrituras críticas se realizan en RPC transaccionales cuando varias tablas
  deben cambiar juntas.
- Eventos entrantes usan inbox/ledger durable; salidas externas usan outbox.
- Reintentar el mismo evento debe ser duplicate-safe dentro de la aplicación.
- Leases recuperables se combinan con fencing token para que un worker vencido
  no cierre trabajo reclamado por otro.
- Estados de negocio y estados técnicos se separan; `FAILED` de un proveedor no
  revierte silenciosamente una decisión humana.
- El contrato extremo a extremo es **at-least-once**: puede haber reintentos y un
  proveedor puede agotar su ventana o aceptar una operación antes de que falle la
  respuesta. Se requiere DLQ, replay y reconciliación; no se promete exactly-once
  ni ausencia absoluta de pérdida fuera de los supuestos documentados.

### Contratos

- Zod valida entradas externas y respuestas privilegiadas.
- Los adaptadores no exponen DTO del proveedor al dominio.
- Los errores enviados al cliente son códigos allowlisted; mensajes, payloads,
  secretos y stack traces nunca cruzan la frontera.
- Versionar contratos de eventos y snapshots antes de incorporar un segundo
  consumidor.

## 5. Escalabilidad y alta disponibilidad

### Etapa actual: marcha blanca y primeras empresas

- Mantener un despliegue web y una base Postgres administrada.
- Escalar horizontalmente Next.js; no guardar sesión ni locks en memoria del
  proceso web.
- Postgres es la autoridad; RLS e índices deben resolver las consultas dentro del
  presupuesto antes de añadir caché.
- Ejecutar workers como invocaciones stateless sobre colas durables en tablas.

### Al crecer el volumen

Activar cambios únicamente por métricas:

- Separar workers del tráfico web cuando consuman CPU/tiempo o necesiten una
  disponibilidad distinta.
- Particionar tablas de eventos/auditoría por tiempo y, solo si el volumen lo
  exige, por tenant de alto tráfico.
- Incorporar pool de conexiones, réplica de lectura y caché de agregados sin PII
  para dashboards. Ninguna caché reemplaza RLS ni es autoridad financiera.
- Extraer el plano de integraciones como servicio independiente cuando existan
  varios proveedores o backlog sostenido; conservar el outbox como frontera.

### Reducir el impacto de dependencias únicas

Vercel, Supabase, el proveedor de correo, Meta, Workera y el ERP siguen siendo
dependencias externas. La aplicación reduce su impacto con degradación explícita:

- Captura web permanece disponible si WhatsApp/correo falla.
- Los reintentos reducen el riesgo de pérdida y el ledger deduplica los eventos
  recibidos; replay y reconciliación cubren reintentos agotados o caídas prolongadas.
- Un ERP caído acumula outbox sin perder decisiones ni marcar éxito falso.
- El asistente no depende de un LLM externo.
- Las operaciones críticas deben tener backup/PITR y restauración probada; alta
  disponibilidad sin recuperación de datos no es resiliencia suficiente.

La etapa actual **no elimina todos los puntos únicos de fallo**: la base primaria
de Supabase, su plano de control y el hosting administrado siguen siendo
dependencias concentradas; tampoco existe un despliegue active-active multi-región.
Antes del piloto se requiere un watchdog independiente para detectar cron/jobs no
ejecutados; el replay manual ya está probado localmente, pero falta su canario en
el ambiente objetivo. Una topología multi-región o un failover
autogestionado solo se justifica si el impacto, SLO y telemetría reales superan el
costo y la complejidad operacional.

El objetivo de 99,9 % solo puede aprobarse después de verificar SLA/HA y límites
del plan contratado, definir pérdida regional y cutover, medir disponibilidad y
asignar error budget al SPOF aceptado. En el estado actual es una aspiración, no
una propiedad del diseño ni un compromiso de proveedor.

## 6. SLO y observabilidad propuestos

Los siguientes objetivos son una propuesta para aprobar antes de producción:

- Disponibilidad mensual de la interfaz autenticada: 99,9 %.
- Latencia p95 de lectura interactiva: menos de 1,5 s; escritura: menos de 2,5 s,
  excluyendo carga de archivos y proveedores externos.
- Éxito de jobs internos: 99,5 % por día. Los objetivos de backlog de 15 min para
  OCR/captura y 30 min para contabilidad solo entran en vigor después de
  provisionar y medir una cadencia compatible; hoy ambos workers están
  programados una vez al día, por lo que esos objetivos aún no aplican.
- Frescura de asistencia: objetivo acordado con RR. HH.; no declarar “al día” si
  no existe una corrida Workera exitosa para el período mostrado.
- Cero cruces tenant, cero escrituras dobles por reintento y cero decisiones
  automáticas son invariantes de seguridad que deben disparar incidente; no son
  un promedio que pueda consumirse dentro de un SLO.

Instrumentación mínima:

- Correlation ID por request, webhook, sync y job.
- Métricas de latencia/error/saturación, profundidad y antigüedad de cola,
  reintentos, leases recuperadas, cuota rechazada y estado por proveedor.
- Logs estructurados y redactados; nunca token, cookies, payload bancario,
  comprobante, RUT, correo ni error externo crudo.
- Alertas por SLO, job sin ejecución, backlog creciente, error sostenido del
  proveedor, restauración fallida y anomalía de autorización, con dueño, on-call,
  umbral, canal y prueba periódica de paging definidos.
- Trazas distribuidas antes de extraer servicios, para conservar causalidad entre
  webhook, ledger, Storage y resultado.

## 7. Arquitectura de seguridad objetivo

### Identidad y acceso

- TOTP nativo de Supabase y AAL2 para cuentas privilegiadas. La implementación
  está integrada en esta rama y validada contra una pila Supabase local aislada;
  no está activada ni desplegada. El rollout sigue obligatoriamente el runbook
  de dos pasos para no bloquear cuentas antes de que inscriban sus factores.
- AAL2 debe imponerse en RLS restrictiva, RPC, Route Handlers, Server Actions y
  SSR, no solo por redirección UI. El test debe cubrir JWT/sesión obsoleta,
  unenrollment, reseteo, revocación y degradación de `aal2` a `aal1`.
- Cuenta owner protegida con dos factores TOTP distintos, recuperación break-glass
  ensayada y auditoría; no asumir códigos de respaldo que Supabase no ofrece.
  Administradores RR. HH. no pueden resetear MFA privilegiado.
- MFA también protege GitHub, Supabase, Vercel, DNS, correo y gestor de secretos;
  la cuenta de aplicación no es la única identidad de alto impacto.
- Permisos por capacidad, no por etiquetas de UI. Toda elevación falla cerrada
  ante `NULL`, membresía inactiva, módulo apagado o empresa bloqueada.
- Login, recuperación, challenge MFA, API, webhook, upload, exportación y acciones
  administrativas necesitan límites hospedados comprobados, CAPTCHA/adaptive
  control donde corresponda, política fail-open/fail-closed y alertas.

### Aplicación, API y datos

- Usar OWASP ASVS 5.0 nivel 2 como baseline trazable y OWASP API Security Top 10
  para Route Handlers/webhooks; mantener matriz requisito→evidencia.
- Validación de tamaño antes de leer cuerpos, firma antes de procesar, allowlist
  de host HTTPS y cero redirects en descargas server-side.
- Cifrado en tránsito y en reposo del proveedor; secretos en gestor del ambiente,
  rotables y separados por staging/producción.
- Storage privado, rutas tenant-aware, URL firmada corta y limpieza de huérfanos.
- PDF/JPG/PNG siguen siendo entrada no confiable. Antes de habilitar correo o
  WhatsApp se exige cuarentena, estado `PENDING_SCAN`, antimalware/CDR según el
  riesgo, bloqueo de descarga hasta resultado limpio y respuesta con
  `Content-Disposition`, `nosniff`, `no-store` y política de referrer.
- `service_role` bypassea RLS: server-only evita exponer la clave, pero no es
  mínimo privilegio. Se requiere inventario por consumidor, autorización previa,
  RPC allowlisted, grants cloud verificados, credenciales/secrets por job cuando
  la plataforma lo permita y pruebas hospedadas de blast radius.
- Cada endpoint tendrá matriz de authn/authz, CSRF/CORS, replay window, rotación de
  firma, rate limit, content type, egress/SSRF, logging y alcance del secreto. Un
  único `CRON_SECRET` para todos los jobs es deuda de blast radius.

### SDLC y cumplimiento

- CI con dependencias reproducibles, lint, TypeScript, pruebas unitarias, build,
  reset completo y pgTAP; revisión Bugbot y Security antes de fusionar.
- SAST, secret scanning, dependencia/SBOM y política de parcheo con SLA.
- DAST y pentest autenticado multiempresa sobre un staging sintético endurecido,
  provenance de artefactos, aprobación de despliegue y rollback ensayado.
- NIST SSDF para el ciclo de desarrollo y NIST CSF 2.0 para gobierno, detección,
  respuesta y recuperación.
- Un eventual SOC 2 requiere evidencia operativa continua; el diseño técnico por
  sí solo no constituye cumplimiento.
- Antes de volver a usar PII en staging o producción: inventario/RoPA, finalidad y
  base jurídica, DPIA por monitoreo laboral/datos sensibles, avisos y derechos,
  retención/supresión/legal hold, contratos con encargados, subprocesadores,
  transferencias internacionales y procedimiento de vulneraciones. La Ley chilena
  21.719 entra en vigor el 1 de diciembre de 2026; asesoría legal debe producir
  estos entregables, no solo una opinión genérica.
- Incident response debe definir severidades, on-call, revocación, preservación
  forense, comunicación interna/externa, contactos de proveedores, tabletop y
  prueba de alertas. El modelo vigente está en `docs/THREAT_MODEL_CURRENT.md`.

## 8. IA segura y gobierno de agentes

La versión actual no usa modelo. El RPC se ejecuta con la sesión del usuario, no
con `service_role`; solo escribe su propia bitácora y una prueba inspecciona que
no contenga DML contra tablas financieras. Es una defensa de repositorio, no una
identidad Postgres de capacidad mínima. Antes de conectar un LLM se debe separar
el cálculo en una frontera de lectura con grants explícitos, sin egress ni RPC de
escritura, y conservar la bitácora fuera de esa capacidad.

La escalera permitida es: (1) regla determinista; (2) modelo opcional que redacta
un resumen minimizado; (3) borrador de intención tipada; (4) backend que descarta
montos/personas/estados propuestos por el modelo, relee los datos, recalcula y
reautoriza; (5) confirmación humana dentro del flujo normal. El modelo nunca
recibe ni posee una herramienta de escritura.

Usos prohibidos: ranking de desempeño, disciplina, despido, modificación salarial,
denegación automática, alteración de asistencia, aprobación, conciliación, pago o
contabilización. OCR, matching y alertas deben mostrar confianza/abstención,
evidencia independiente, motivo de aceptación/override y vía de corrección o
apelación. El revisor necesita competencia y autoridad real; un clic humano no
convierte una decisión automática en supervisión significativa.

Privacidad por finalidad:

- Allowlist de campos por intención y rol; agregación/umbrales para grupos pequeños.
- Nunca enviar documento, OCR, dato bancario/laboral o identificador si una cifra
  agregada satisface la finalidad; no conservar texto libre.
- Retención diferenciada, derechos del titular, encargados y transferencias deben
  aprobarse antes de habilitar proveedor externo.
- La respuesta audit-grade futura incluye `asOf`, versión de cálculo/regla, zona
  horaria, moneda/unidad/redondeo, total de evidencias y manifiesto paginado. El
  SHA-256 actual no sustituye HMAC/firma o un registro inmutable.

Gobierno operativo alineado con NIST AI RMF: inventario de sistemas/modelos, riesgo
por caso de uso, owner y RACI, autoridad GO/NO-GO, dataset/eval/versiones, umbrales
de exactitud y abstención, monitoreo/drift, incidentes/quejas, kill switch,
rollback y retiro seguro. Cada versión se evalúa con cruces tenant, cifras exactas,
sesgo, alucinación, prompt injection, fuga, costo y disponibilidad.

Los agentes de código requieren plan empresarial/no-training aprobado, retención y
residencia revisadas, repos allowlisted, sandbox efímero, egress restringido, cero
secretos o datos productivos, trazas, CODEOWNERS y doble revisión para RLS,
migraciones y finanzas. Dependencias nuevas pasan lockfile, provenance/licencias,
SBOM y allowlist; los modos personal, empresarial, local y cloud no se consideran
equivalentes.

## 9. Evaluación de firmas y herramientas

No existe una firma universalmente “mejor”. Las siguientes son **candidatas**, no
ganadoras: la contratación debe basarse en scorecard y PoC sobre este repositorio,
equipo nominal, experiencia Chile/Supabase/RLS, TCO, SLA, referencias comparables,
propiedad del código, transferencia de conocimiento, seguridad y operación.

- **Globant** publica capacidades de ejecución de producto y cloud a escala,
  arquitectura, APIs, cloud-native y CloudOps/SRE. Su ajuste al equipo debe
  validarse mediante la PoC.
- **Accenture** publica capacidades para modernización, gobierno, integración y
  cambio organizacional de gran escala. Su costo y ajuste a una marcha blanca
  pequeña deben validarse con un alcance acotado.
- **Thoughtworks** publica prácticas de modularización evolutiva, plataformas,
  entrega continua y transferencia de ingeniería. Que sean las adecuadas para
  este repositorio sigue siendo una hipótesis de la PoC.

Para desarrollo asistido:

- **OpenAI Codex/repo-native agent** es un candidato natural para este brownfield:
  puede inspeccionar el repositorio, ejecutar tests, trabajar en ramas y someter
  cambios a revisión. Su selección definitiva requiere el mismo benchmark y los
  controles de datos, red, sandbox y revisión de la sección 8.
- **GitHub Copilot y agentes de terceros** son útiles dentro del flujo de PR, pero
  sus permisos y riesgos de ejecución deben revisarse por repositorio.
- **Replit Agent, Lovable y Bolt** sirven para prototipos o superficies UI
  aisladas. No deben ser autoridad sobre RLS, migraciones, contabilidad o nómina.
  En particular, la documentación de Bolt advierte límites relevantes para
  Supabase/Next.js y que el historial de versiones no restaura la base de datos.
  “Aislado” significa repositorio y tenant desechables, datos sintéticos, cero
  secretos/integraciones reales, egress acotado, export verificable y borrado
  contractual. Lovable no importa este repositorio existente, por lo que no es
  candidato para el core brownfield.

## 10. Plan de evolución

### Gate P0 — antes de usar PII en staging o producción

- Poner el staging actual en hold, clasificar sus 97 registros y reemplazar por
  datos sintéticos/minimizados o aplicar controles equivalentes a producción.
- Aprobar `docs/THREAT_MODEL_CURRENT.md` con owners y aceptación residual.
- Activar MFA/AAL2 en un ambiente hospedado siguiendo el rollout de dos pasos;
  ensayar recuperación owner con segundo TOTP, revocación y rollback de la capa
  RPC antes de habilitar el enforcement.
- Verificar rate limits/Auth/CAPTCHA y controles de abuso en Supabase hospedado.
- Demostrar aislamiento del dominio laboral con una segunda empresa real/sintética
  completa y un inventario continuo de tablas, views, RPC, Storage, exports, jobs
  y rutas; hasta entonces Workera, asistencia y nómina son `NO-GO` multiempresa.
- Contratar/verificar backups y PITR; ejecutar una restauración aislada con datos
  y Storage, checksums/copia independiente, reconfigurar Auth/keys/Realtime/jobs,
  medir RPO/RTO, cutover/rollback y conservar evidencia.
- Mantener el inventario tipado de `service_role` ya implementado; restringir
  grants cloud y separar secretos/jobs; elegir gestor, RBAC, owner, rotación,
  revocación y break-glass auditado. El inventario no sustituye esas fronteras.
- Demostrar segregación maker-checker, recertificación/caducidad de accesos,
  límites de descarga/exportación y alertas por uso anómalo para mitigar abuso
  de usuarios legítimamente autorizados.
- Implementar cuarentena/antimalware antes de habilitar captura externa.
- Activar y monitorear el scheduler/watchdog contable ya implementado, probar el
  catch-up y la DLQ maker-checker en el ambiente, y reconciliar resultados ERP
  inciertos conservando la idempotency key.
- Configurar observabilidad y un plan de incident response; probar paging,
  tabletop, revocación y comunicaciones de vulneración.
- Enviar eventos críticos de auth, admin, descargas, exportaciones,
  `service_role` y backup a un sink externo/tamper-evident, con retención,
  acceso y revisión independientes de los administradores de la aplicación.
- Rotar secretos, separar ambientes y ejecutar canarios de Workera, correo,
  WhatsApp, importación bancaria y contabilidad con flags y rollback.
- Completar entregables legales: RoPA/inventario, base/finalidad, DPIA, avisos,
  derechos, retención, contratos, transferencias y breach response.
- Ejecutar matriz ASVS L2, DAST y pentest autenticado multitenant.
- Ejecutar prueba de carga y 14 días de soak en staging sin backlog o errores
  sostenidos, solo después de sanear el ambiente.

### Gate P1 — piloto controlado

- Una empresa piloto por canal, cupos conservadores y conciliación siempre humana.
- Runbook de proveedor caído, replay de webhook, recuperación de lease, purga y
  exportación contable.
- Versionar el contrato audit-grade del asistente (`asOf`, regla, zona horaria,
  redondeo, manifiesto) y su capacidad Postgres de lectura antes de conectar LLM.
- Revisión diaria de métricas y auditoría semanal de permisos durante la marcha
  blanca.

### Gate P2 — escala multiempresa

- Incorporar tenants por cohortes, con test de aislamiento y restauración antes de
  cada incremento relevante.
- Extraer workers solo cuando latencia, backlog o equipos independientes lo
  justifiquen.
- Revisar particionamiento, réplica, pool y presupuesto según telemetría real.

## 11. Riesgos abiertos y decisión de lanzamiento

Estado actual: **GO para desarrollo local aislado; NO-GO para el staging actual
con datos de empleados y NO-GO para producción**. Un staging nuevo o saneado solo
puede usarse con datos sintéticos/minimizados, conectores reales apagados y acceso
restringido hasta cerrar los P0.

Bloqueos principales:

- Dominio laboral todavía no demostrado como seguro para una segunda empresa.
- Backup/PITR y restore drill no implementados ni probados.
- MFA está integrado y probado localmente, pero no existe evidencia hospedada de
  inscripción, activación, recuperación y rollback.
- El threat model vigente no tiene aceptación formal ni owners asignados.
- Abuso/Auth, antimalware, blast radius de `service_role` e incident response no
  tienen evidencia operacional.
- Proveedores reales no tienen canario completo ni secretos productivos validados.
- Scheduler, watchdog y replay terminal contables existen en código, pero no
  están activados ni monitoreados independientemente en un ambiente real.
- No existe evidencia de SLO/alertas/soak de producción.
- Falta el paquete legal/privacidad para datos laborales y financieros.

## 12. Fuentes de referencia del comité

Arquitectura y firmas:

- [Globant Engineering](https://www.globant.com/studio/engineering)
- [Globant CloudOps](https://now.globant.com/en/cloudops-services/)
- [Accenture Application Transformation](https://www.accenture.com/en/services/cloud/application-transformation)
- [Accenture Application Modernization](https://www.accenture.com/en/services/cloud/application-transformation/application-modernization)
- [Thoughtworks — Building Evolutionary Architectures](https://www.thoughtworks.com/en-us/insights/books/building-evolutionary-architectures)
- [Thoughtworks — Platform engineering](https://www.thoughtworks.com/insights/blog/platforms/the-evolution-of-platform-engineering--lessons-from-the-trenches)

Seguridad y gobierno:

- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP API Security](https://owasp.org/API-Security/)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [NIST Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final)
- [NIST Cybersecurity Framework 2.0](https://www.nist.gov/cyberframework)
- [AICPA SOC 2](https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2/)
- [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa)
- [Supabase Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase — Restore to a new project](https://supabase.com/docs/guides/platform/clone-project)
- [Ley chilena 21.719](https://www.bcn.cl/leychile/Navegar?idNorma=1209272&idVersion=2026-12-01)

Agentes y plataformas AI:

- [OpenAI Codex](https://openai.com/codex/)
- [OpenAI — Running Codex safely](https://openai.com/index/running-codex-safely/)
- [GitHub — Third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- [GitHub — Agent risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)
- [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
- [Replit Agent](https://docs.replit.com/learn/build-with-agent)
- [Lovable Security](https://docs.lovable.dev/features/security)
- [Lovable GitHub integration](https://docs.lovable.dev/integrations/github)
- [Bolt Supabase integration limits](https://support.bolt.new/integrations/supabase)
- [Bolt security audit on publish](https://bolt.new/blog/security-audit-on-publish)
