# Modelo de amenazas vigente — GESTORA / Workera

Fecha de revisión: 4 de septiembre de 2026. Alcance: rama
`codex/phases2-6-autonomous`, incluidos UI/SSR, Route Handlers, Supabase Auth,
Postgres/RLS, Storage, `service_role`, Workera, Rendiciones Fases 2–6, PWA,
webhooks, jobs y agentes de desarrollo. No afirma despliegue de esta rama.

## Estado y lenguaje de evidencia

- `IMPLEMENTED`: existe en código/migración.
- `TESTED_LOCAL`: además tiene prueba automatizada en la instancia aislada.
- `DEPLOYED_STAGING`: verificado contra el proyecto remoto indicado.
- `UNVERIFIED`: diseñado o implementado sin evidencia del ambiente real.
- `BLOCKED`: riesgo no aceptable antes de PII en staging/producción.

Un review limpio de un diff significa que no quedaron hallazgos dentro de ese
diff; no equivale a pentest, aceptación de riesgo ni eficacia operacional. Este
modelo requiere owner y aceptación formal antes de cambiar un `BLOCKED`.

## Activos y fronteras de confianza

Activos críticos: identidad/MFA; empresa y membresía; marcaciones, horarios,
licencias y nómina; rendiciones, comprobantes, cartolas y salidas contables;
objetos privados; secretos de proveedores; bitácora; backups; disponibilidad y
capacidad de recuperación.

Fronteras:

1. Persona → navegador/PWA.
2. Navegador → Next.js Proxy/SSR/Actions/Route Handlers.
3. Sesión de usuario → Supabase Auth/PostgREST/RPC sujeto a RLS.
4. Servicio server-only → cliente `service_role` que bypassea RLS.
5. Resend/Meta/Workera/Vercel/ERP → webhooks, cron y adaptadores.
6. Archivo no confiable → cuarentena/Storage/descarga.
7. Git/CI/agente de código → repositorio, dependencias y despliegue.
8. Operador de infraestructura → Supabase, Vercel, DNS, secretos y backups.

## Riesgos actuales

### TM-01 — toma de cuenta privilegiada y bypass de MFA

- Riesgo: un AAL1, JWT antiguo, unenrollment o recuperación débil permite una
  operación de plataforma/RR. HH./Finanzas.
- Evidencia: TOTP/AAL2 existe en una rama separada; no está integrado aquí.
- Estado: `BLOCKED`.
- Control requerido: AAL2 en RLS restrictiva, RPC, API, SSR y Actions; dos
  factores TOTP para owner; revocación/recuperación ensayada; MFA en GitHub,
  Supabase, Vercel, DNS, correo y gestor de secretos.
- Owner requerido: IAM/Platform. Riesgo residual: no aceptado.

### TM-02 — credential stuffing, enumeración y abuso de superficies

- Riesgo: login, recuperación, challenge MFA, APIs, webhooks, uploads,
  exportaciones o acciones admin consumen recursos o revelan cuentas/datos.
- Evidencia: controles puntuales de tamaño/cuota y `CRON_SECRET`; el plan global
  de abuse/rate limiting sigue `PLANNED/TBD` y no fue comprobado hospedado.
- Estado: `BLOCKED`.
- Control requerido: límites por identidad/IP/empresa, protección adaptativa o
  CAPTCHA cuando proceda, respuestas no enumerables, alerta y política explícita
  fail-open/fail-closed por endpoint.
- Owner requerido: Security/Platform. Riesgo residual: no aceptado.

### TM-03 — cruce entre empresas

- Riesgo: lectura, escritura, Storage, job, export o caché mezcla tenants.
- Evidencia: Rendiciones tiene `company_id`, RLS y pruebas negativas locales;
  aislamiento laboral completo con segunda empresa no está demostrado.
- Estado: Rendiciones `TESTED_LOCAL`; asistencia/nómina `BLOCKED` para multitenant.
- Control requerido: inventario automático de tablas/views/RPC/Storage/routes/
  jobs, FK compuestas o invariantes equivalentes, pruebas hosteadas y controles
  especiales para superadmin/control plane.
- Owner requerido: Data Architecture/Security. Residual: no aceptado en laboral.

### TM-04 — abuso o filtración de `service_role`

- Riesgo: la clave bypassea RLS y una filtración o ruta mal autorizada afecta toda
  la base; los grants cloud son más amplios que en local.
- Evidencia: cliente `server-only`, consumidores acotados por módulos y tests que
  impiden uso directo desde rutas/actions; no existe identidad mínima por job ni
  verificación completa de grants hospedados.
- Estado: límite de código `TESTED_LOCAL`; blast radius `BLOCKED`.
- Control requerido: inventario por consumidor, autorización antes del cliente
  admin, RPC allowlisted, secretos separados cuando sea posible, grants cloud
  explícitos, rotación/revocación y test hosteado.
- Owner requerido: Platform/Security. Residual: no aceptado.

### TM-05 — archivo malicioso o contenido activo

- Riesgo: PDF/JPG/PNG de web, correo o WhatsApp explota parser/navegador, se sirve
  inline o llega a RR. HH. sin inspección.
- Evidencia: límites, MIME + magic bytes, tipos allowlisted y Storage privado;
  no existe cuarentena/antimalware/CDR.
- Estado: `BLOCKED` para conectores externos y piloto con archivos reales.
- Control requerido: `PENDING_SCAN`, bucket de cuarentena, antimalware/CDR según
  riesgo, no descarga antes de `CLEAN`, `Content-Disposition`, `nosniff`,
  `no-store`, referrer policy y purga de infectados.
- Owner requerido: Security/Expenses. Residual: no aceptado.

### TM-06 — webhook falsificado, replay o SSRF

- Riesgo: evento sin firma/repetido, cuerpo grande, URL hostil o redirect accede a
  red interna/metadata y crea filas/objetos.
- Evidencia: firma, límites, allowlist HTTPS, no redirects, ledger, cuotas,
  idempotencia, leases/fencing probados localmente; proveedores reales apagados.
- Estado: `TESTED_LOCAL`, integración real `UNVERIFIED`.
- Control requerido: matriz por endpoint, replay window, rotación dual de firma,
  egress restringido, canario y reconciliación del proveedor.
- Owner requerido: Integrations/Security. Residual: medio hasta canario.

### TM-07 — evento perdido, duplicado o resultado externo incierto

- Riesgo: proveedor agota reintentos, PITR revive un ledger antiguo, ERP acepta y
  la respuesta se pierde, o un worker obsoleto completa el job.
- Evidencia: inbox/outbox, idempotency key, `SKIP LOCKED`, leases/fencing y retry.
  La entrega es at-least-once; no hay exactly-once extremo a extremo.
- Estado: mecanismo `TESTED_LOCAL`; DLQ/replay/reconciliación `BLOCKED` para piloto.
- Control requerido: scheduler, watchdog, catch-up, alerta, inspección, requeue
  segura con la misma key y reconciliación de resultado ERP incierto.
- Owner requerido: Integrations/Finance Ops. Residual: no aceptado para piloto.

### TM-08 — decisión financiera o laboral automática/incorrecta

- Riesgo: OCR, matching, alerta o AI induce aprobación, pago, marcación,
  remuneración, disciplina o rechazo incorrectos.
- Evidencia: separación de sugerencia y decisión; asistente determinista sin LLM
  ni herramientas de escritura.
- Estado: controles base `TESTED_LOCAL`; proceso humano/legal `UNVERIFIED`.
- Control requerido: usos prohibidos, confianza/abstención, evidencia, motivo de
  override, corrección/apelación, revisor competente y DPIA cuando corresponda.
- Owner requerido: Finance/RR. HH./Privacy. Residual: no aceptado sin proceso.

### TM-09 — falsedad de frescura Workera

- Riesgo: dashboard declara “al día” con sync fallido, parcial o de otra empresa.
- Evidencia: runs/eventos versionados, empresa explícita y motor de reglas; el
  staging histórico requiere validación continua y segunda empresa.
- Estado: `DEPLOYED_STAGING` parcial; multiempresa laboral `BLOCKED`.
- Control requerido: SLI de frescura, watermark por período/empresa, reconciliación
  de conteos, alerta de run ausente/parcial y no mostrar éxito sin corrida válida.
- Owner requerido: Attendance Ops. Residual: no aceptado multitenant.

### TM-10 — filtración por PWA/caché/navegador

- Riesgo: HTML autenticado, API, documento, export o PII persiste offline.
- Evidencia: service worker solo cachea assets públicos e inmutables; navegación
  prioriza red y fallback público; pruebas de paths sensibles.
- Estado: `TESTED_LOCAL`, navegadores/dispositivos reales `UNVERIFIED`.
- Control requerido: canario Safari/Chrome, headers `no-store`, logout/clear-site
  y regresión de caché en cada nueva ruta sensible.
- Owner requerido: Web/Security. Residual: bajo-medio hasta canario.

### TM-11 — asistente con evidencia incompleta o historial excesivo

- Riesgo: 12 citas se interpretan como manifiesto completo, SHA-256 como firma, o
  el historial retiene referencias/agregados más de lo necesario.
- Evidencia: consulta allowlisted, Zod, permisos por intención, propio historial,
  90 días, digest y purga diaria; no LLM.
- Estado: `TESTED_LOCAL`, finalidad/legal y contrato audit-grade `UNVERIFIED`.
- Control requerido: renombrar como reproducible, `asOf`/versión/zona/moneda/
  redondeo, manifiesto paginado, retención por finalidad y capacidad DB mínima
  antes de conectar un modelo.
- Owner requerido: Expenses/Privacy. Residual: medio.

### TM-12 — pérdida/corrupción de DB o Storage

- Riesgo: borrado, corrupción, ransomware, región o cuenta comprometida; DB se
  restaura sin binarios o metadata/objetos quedan de instantes distintos.
- Evidencia: plan escrito; no hay backup/PITR/restore drill comprobado. Backups DB
  del proveedor no incluyen objetos Storage.
- Estado: `BLOCKED`.
- Control requerido: copia DB+Storage con manifiesto/checksum y punto de corte,
  copia cifrada cross-account/off-site/immutable, alerta de ausencia/corrupción,
  restore aislado, reconfiguración, cutover/rollback y drills periódicos.
- Owner requerido: Platform/DR. Residual: no aceptado.

### TM-13 — alteración o borrado de auditoría por administrador

- Riesgo: un operador DB/proyecto puede cambiar el log aunque la app sea
  append-only.
- Evidencia: triggers/grants frente a roles de aplicación; no hay sink externo
  inmutable ni cobertura integral de auth/admin/download/export/backup.
- Estado: `UNVERIFIED` / `BLOCKED` para evidencia regulatoria.
- Control requerido: sink tamper-evident separado, retención, acceso y revisión;
  correlación de eventos de infraestructura y aplicación.
- Owner requerido: Security/Audit. Residual: no aceptado como evidencia formal.

### TM-14 — compromiso de secretos, CI o supply chain

- Riesgo: dependencia/agente/PR roba secretos, introduce paquete malicioso o
  publica artefacto no revisado.
- Evidencia: env no versionado, server-only, lint/tests/reviews; gestor, SBOM,
  provenance y política operacional no están completos.
- Estado: `UNVERIFIED`.
- Control requerido: gestor y RBAC, rotación/revocación/break-glass, secret scan,
  dependabot/SCA, lockfile, SBOM/provenance, CODEOWNERS, doble revisión y sandbox/
  egress acotado para agentes.
- Owner requerido: DevSecOps. Residual: medio-alto.

### TM-15 — indisponibilidad y dependencia concentrada

- Riesgo: Supabase Auth/Postgres/Storage, Vercel/scheduler o proveedor regional
  detiene el servicio; 99,9 % no está sustentado.
- Evidencia: degradación funcional y colas durables; no active-active ni failover
  regional probado.
- Estado: `UNVERIFIED`.
- Control requerido: SLA/HA del plan, error budget, synthetic checks, watchdog,
  pérdida regional/cutover y restore; aceptar formalmente el SPOF residual o pagar
  una topología superior.
- Owner requerido: Platform/Product. Residual: no aceptado.

### TM-16 — incidente o vulneración sin respuesta

- Riesgo: detección tardía, evidencia perdida, credenciales activas y notificación
  incumplida.
- Evidencia: logs puntuales; no existe IR plan/tabletop/on-call probado.
- Estado: `BLOCKED`.
- Control requerido: severidades, RACI/on-call, preservación forense, rotación,
  contactos, comunicaciones, obligaciones legales, tabletop y prueba de paging.
- Owner requerido: Security/Legal/Leadership. Residual: no aceptado.

### TM-17 — abuso por usuario legítimamente autorizado

- Riesgo: una cuenta con permisos válidos realiza descargas/exportaciones
  masivas, consulta PII fuera de su finalidad o combina funciones para crear y
  aprobar fraude; RLS correcta no impide el abuso dentro del alcance concedido.
- Evidencia: capacidades server-side, aprobación humana y algunos logs; no hay
  segregación maker-checker demostrada en todos los flujos, recertificación
  periódica, límites de volumen ni detección de anomalías.
- Estado: `UNVERIFIED` / `BLOCKED` para staging con PII y piloto.
- Control requerido: matriz de segregación y conflictos, doble control para
  pagos/contabilidad, recertificación y caducidad de accesos, límites y alertas
  por descarga/exportación, detección de volumen/comportamiento anómalo y
  revisión de un sink tamper-evident independiente.
- Owner requerido: Security/Finance/Privacy. Residual: no aceptado.

## Decisión y revisión

- Desarrollo local aislado con datos sintéticos: permitido.
- Staging actual con 97 registros de empleados: `NO-GO` hasta clasificar/sanear o
  aplicar los controles P0 equivalentes a producción.
- Conectores reales, piloto con archivos y producción: `NO-GO`.

Este modelo se revisa en cada nueva integración, uso de `service_role`, tipo de
archivo, decisión automatizada, cambio de proveedor o incidente; como mínimo,
antes de cada gate de ambiente. La aceptación residual debe registrar riesgo,
owner, fecha, compensación, expiración y autoridad que aprueba.

Referencias: `docs/TARGET_ARCHITECTURE_PHASES_2_6.md`,
`docs/BACKUP_RECOVERY_PLAN.md`, `docs/API_SECURITY_STANDARD.md`,
`docs/ABUSE_RATE_LIMITING_PLAN.md`, OWASP ASVS/API Security, NIST SSDF/CSF/AI RMF,
Supabase MFA/Backups/Clone Project y Ley chilena 21.719.
