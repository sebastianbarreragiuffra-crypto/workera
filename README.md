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

La arquitectura vigente, las decisiones reemplazadas y la secuencia segura de
continuación están en
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
- Rendiciones EX-1 ya tiene fundación multiempresa independiente y un botón
  **Agregar Rendiciones** en el detalle de cualquier cliente. La captura,
  aprobación y conciliación operacionales se construirán en las fases siguientes.
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
  add-on de Rendiciones se prueba en `042_expenses_multi_company_foundation.sql`.

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
npx supabase test db
npm run build
```

Para validar una reconstrucción local completa se puede usar
`npx supabase db reset`; nunca ejecutar un reset sobre staging o producción.
Las instrucciones del ambiente compartido están en
[docs/STAGING_ENVIRONMENT.md](docs/STAGING_ENVIRONMENT.md).

## Referencias principales

- [Arquitectura multiempresa](docs/PLATFORM_MULTI_COMPANY.md)
- [Modelo de acceso histórico del workspace](docs/ACCESS_MODEL_PHASE5D.md)
- [Estándar de seguridad de APIs](docs/API_SECURITY_STANDARD.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Decisiones pendientes](docs/DECISIONS_PENDING.md)
- [Sincronización Workera](docs/WORKERA_SYNC_PHASE6B.md)
