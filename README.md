# GESTORA

Plataforma multiempresa para administrar clientes, personas y operaciones de
RRHH. ARCOTEX es el primer workspace operativo; Workera es una integración de
ese workspace, no la identidad ni el límite arquitectónico del producto.

## Pinned — contexto obligatorio

- **Conservar el trabajo existente.** No reconstruir la aplicación desde cero,
  no crear una versión paralela y no revertir migraciones o decisiones vigentes.
- Hay dos contextos separados: el **control plane GESTORA**, que administra la
  cartera de empresas, y el **workspace de cada empresa**, que ejecuta sus
  procesos. Los roles globales no conceden acceso automático a datos laborales.
- MT-3A implementa el control plane, roles y permisos por empresa, módulos,
  onboarding y organigrama. Una empresa nueva nace en `ONBOARDING` con
  `workspace_enabled = false`.
- **Solo ARCOTEX puede operar actualmente el dominio laboral.** No habilitar el
  workspace laboral de una segunda empresa hasta completar MT-3B–D. Rendiciones
  es la primera excepción modular: posee tablas, relaciones, permisos y RLS
  tenant-aware propios y puede activarse sin cambiar `workspace_enabled`.
- La variación entre clientes se resuelve con catálogo de módulos, entitlements,
  configuración y permisos por empresa. No crear forks de código por cliente.
- `platform_memberships` es la autoridad de roles de plataforma
  (`OWNER`, `ADMIN`, `SUPPORT`, `VIEWER`). `profiles.role` y los cuatro roles
  históricos continúan solo como compatibilidad temporal del workspace ARCOTEX.
- `organization_units` representa la jerarquía real de la empresa.
  `employee_groups` sigue siendo una clasificación para reglas laborales y no
  debe reutilizarse como organigrama.
- Ocultar una opción en la UI nunca reemplaza autorización backend, RLS ni el
  gate del módulo. No exponer `service_role`, credenciales de Supabase o Workera,
  datos médicos, bancarios ni payloads sensibles.
- Este proyecto usa Next.js `16.3.3`, con cambios respecto de versiones previas.
  Antes de escribir código Next, leer la guía aplicable en
  `node_modules/next/dist/docs/`, tal como exige `AGENTS.md`.

La arquitectura total, el control de flujos, los gates de seguridad y la
secuencia de evolución están en
[docs/TARGET_ARCHITECTURE_PHASES_2_6.md](docs/TARGET_ARCHITECTURE_PHASES_2_6.md).
La decisión ejecutable por alcance y la secuencia de marcha blanca están en
[docs/PILOT_READINESS_RUNBOOK.md](docs/PILOT_READINESS_RUNBOOK.md); `npm run
readiness:report` es la lectura vigente y no debe sustituirse por una estimación.
El detalle del límite multiempresa y las decisiones reemplazadas está en
[docs/PLATFORM_MULTI_COMPANY.md](docs/PLATFORM_MULTI_COMPANY.md).

## Estado actual resumido

- Fundación tenant: `companies`, `company_memberships` y resolución de empresa
  activa.
- Control plane MT-3A: ciclo de vida de clientes, membresías globales, RBAC
  configurable por empresa, módulos, invitaciones, onboarding, organigrama y
  auditoría de plataforma.
- ARCOTEX conserva sus flujos de asistencia, novedades, documentos, nómina e
  integración Workera. Esos dominios todavía no están completamente aislados
  para operar una segunda empresa.
- Rendiciones EX-1/EX-2/EX-3 ya tiene fundación multiempresa independiente, botón
  **Agregar Rendiciones**, selector de empresa, dashboard, borradores, ítems,
  folios correlativos, comprobantes privados versionados, alerta de duplicados,
  envío seguro y bandeja de aprobación sin autoaprobación.
- EX-5 agrega retiro de una rendición enviada por su propio dueño, monto
  máximo por categoría vía `expense_policies.rules`, y cadenas de aprobación
  multi-paso: si el total supera un umbral configurable se exige un segundo
  aprobador -- nunca la misma persona resolviendo dos pasos de la misma
  ronda, aunque su rol tenga permiso formal para ambos. Los pasos requeridos
  se congelan al enviar (`required_approval_steps`) y nunca se releen en
  vivo mientras la revisión está en curso.
- EX-6 agrega conciliación: una rendición ya APROBADA se puede marcar como
  pagada con una referencia de pago o asiento contable obligatoria (`paid_at`,
  `paid_by`, `payment_reference`). Nunca reabre la revisión ni ajusta el
  monto aprobado; queda auditada como cualquier otro cambio de estado.
- EX-4 agrega extracción OCR asíncrona de comprobantes (Azure Document
  Intelligence, `prebuilt-receipt`) mediante una cola propia
  (`expense_ocr_jobs`) con reintentos acotados, leases recuperables y
  aislamiento por `company_id` en cada paso. El worker nunca sobrescribe los
  montos declarados por la persona: solo dejan discrepancias visibles y exigen
  revisión humana con comentario obligatorio al rechazar. Completo y validado
  en local; **todavía sin desplegar a staging** y con Azure deshabilitado
  (`EXPENSE_OCR_ENABLED=false` por defecto) hasta configurar credenciales
  reales -- ningún resultado de esta fase fue probado contra la API de Azure
  en producción.
- Los archivos externos de correo/WhatsApp entran a cuarentena antes de OCR.
  El worker de seguridad, leases, checksum y canarios sintéticos ya existe,
  pero su único scanner es un fixture que no puede activarse en producción.
  `EXPENSE_FILE_SCAN_ENABLED=false` y ambos canales deben seguir apagados hasta
  seleccionar y verificar un proveedor antimalware real; ver
  [docs/EXPENSE_FILE_QUARANTINE.md](docs/EXPENSE_FILE_QUARANTINE.md).
- MFA (TOTP) para cuentas privilegiadas está **en master y desplegado en
  staging alojado** desde el commit `138288d`: el dominio canónico es
  `https://arcotex-workera-staging.vercel.app`, Vercel tiene
  `MFA_ENFORCEMENT_ENABLED=true`, Google OAuth fue comprobado hasta
  `/login/mfa` y la única identidad que actualmente coincide con el conjunto
  privilegiado tiene dos factores verificados. Nuevas identidades que entren
  a ese conjunto deberán inscribirse en su primer acceso. Incluye:
  inscripción y gestión de factores, desafío en el login por contraseña y por
  OAuth, gate de middleware detrás de `MFA_ENFORCEMENT_ENABLED` (default
  `false`), guarda `aal2` dentro de los RPC sensibles y en las Server Actions
  que cambian factores, reseteo solo por el OWNER de plataforma y bitácora
  append-only `mfa_events`. La migración `20260904150000` corrige, además, un
  agujero previo y ajeno a MFA: cinco guardas de autorización devolvían NULL en
  vez de `false`, y en PL/pgSQL `if not guarda()` sobre NULL nunca lanza la
  excepción. El bloqueo se activa en dos pasos y **el orden de aplicación de las
  migraciones ya no es libre**: el procedimiento vigente, incluido el
  break-glass del OWNER, está en
  [docs/PLATFORM_OWNER_RUNBOOK.md](docs/PLATFORM_OWNER_RUNBOOK.md).
- El dashboard usa KPIs agregados y la cartera se busca, filtra y pagina en el
  servidor. El detalle carga solo la pestaña solicitada y pagina membresías;
  administrar la plataforma no implica leer automáticamente la nómina de cada
  cliente.
- Las invariantes principales se prueban en
  `supabase/tests/035_gestora_tenant_foundation.sql`,
  `036_future_table_grants_lockdown.sql` y
  `037_platform_control_plane.sql`, los RPC de gestión en
  `038_platform_management_rpcs.sql`, la proyección privada del organigrama en
  `039_platform_organization_projection.sql`, las consultas escalables del
  portafolio en `040_platform_portfolio_queries.sql` y el bloqueo de escrituras
  alternativas en `041_platform_security_hardening.sql`. El aislamiento del
  add-on de Rendiciones se prueba en `042_expenses_multi_company_foundation.sql`
  y su flujo operativo en `043_expenses_operational_workflow.sql`; la privacidad
  de comprobantes y segregación de aprobación, junto con las cadenas de
  aprobación multi-paso de EX-5, se prueban en
  `044_expenses_receipts_and_approvals.sql`; la cola OCR de EX-4 (encolado
  automático, claim concurrente, leases, reintentos, cancelación al
  reemplazar comprobante y aislamiento entre empresas) se prueba en
  `045_expenses_ocr_pipeline.sql`; la conciliación de EX-6 (solo aprobadas,
  referencia obligatoria, no se concilia dos veces, aislamiento entre
  empresas) se prueba en `046_expense_report_reconciliation.sql`. MFA se prueba
  en tres archivos: `049_mfa_totp_foundation.sql` cubre quién exige segundo
  factor, la guarda `aal2`, el reseteo restringido al OWNER, que una cuenta
  desactivada no conserve ninguna de esas capacidades y que `mfa_events` sea
  append-only incluso para `postgres`; `050_null_authorization_guard_fixes.sql`
  fija que las guardas de autorización devuelvan `false` y nunca NULL; y
  `051_mfa_security_hardening.sql` lleva esa comprobación extremo a extremo a
  las seis superficies del control plane que modifican estado. El nombre del
  tercero es engañoso: cubre las guardas NULL, no el endurecimiento de MFA, que
  vive en el primero.

## Desarrollo local

Requisitos: Node.js, Docker Desktop y Supabase CLI. La configuración completa y
los puertos canónicos están en [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

```bash
npm install
npx supabase start
npm run dev
```

Abrir `http://localhost:3000`. Los archivos `.env`, `.env.local` y
`.env.staging` no se versionan ni se comparten por chat.

## Validación

```bash
npm run lint
npx tsc --noEmit
npm test
npm run readiness:local
npx supabase test db
npm run build
```

Para validar una reconstrucción local completa se puede usar
`npx supabase db reset` **solo después de aislar el worktree** como indica
`docs/LOCAL_SETUP.md`; la pila local es compartida entre worktrees. Nunca
ejecutar un reset sobre staging o producción.
Las instrucciones del ambiente compartido están en
[docs/STAGING_ENVIRONMENT.md](docs/STAGING_ENVIRONMENT.md).

## Referencias principales

- [Arquitectura total, escalabilidad y control de flujos](docs/TARGET_ARCHITECTURE_PHASES_2_6.md)
- [Arquitectura multiempresa](docs/PLATFORM_MULTI_COMPANY.md)
- [Modelo de acceso histórico del workspace](docs/ACCESS_MODEL_PHASE5D.md)
- [Estándar de seguridad de APIs](docs/API_SECURITY_STANDARD.md)
- [Threat model](docs/THREAT_MODEL.md)
- [MFA (TOTP) para cuentas privilegiadas](docs/MFA_DESIGN.md)
- [Runbook de la cuenta OWNER](docs/PLATFORM_OWNER_RUNBOOK.md)
- [Readiness y marcha blanca](docs/PILOT_READINESS_RUNBOOK.md)
- [Decisiones pendientes](docs/DECISIONS_PENDING.md)
- [Sincronización Workera](docs/WORKERA_SYNC_PHASE6B.md)
