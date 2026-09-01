# GESTORA — arquitectura multiempresa

Estado: **MT-3A implementado como control plane y fundación segura**. Este
documento describe la decisión vigente; los documentos de fases anteriores se
conservan como historial del workspace ARCOTEX.

## 1. Límite del sistema

GESTORA tiene dos planos explícitos:

1. **Control plane de plataforma**: cartera de empresas cliente, ciclo de vida,
   onboarding, usuarios, roles, módulos, configuración y salud agregada.
2. **Workspace de empresa**: empleados y procesos operacionales de RRHH de una
   sola empresa.

La pertenencia al control plane vive en `platform_memberships`. La pertenencia a
una empresa vive en `company_memberships`. Ninguna de las dos debe inferirse
desde la otra. Un `OWNER` o `ADMIN` de plataforma puede administrar clientes,
pero no recibe por ello acceso irrestricto a datos laborales.

## 2. Qué ya está implementado en MT-3A

La migración `20260901120000_platform_control_plane.sql` agrega, sin reemplazar
los flujos existentes:

- ciclo de vida y gate operacional en `companies`;
- roles globales `OWNER`, `ADMIN`, `SUPPORT` y `VIEWER`, con protección del
  último `OWNER` activo;
- catálogo de módulos y estado independiente por empresa (`ENABLED`,
  `DISABLED`, `PILOT`, `SETUP_REQUIRED`);
- RBAC empresarial mediante roles, permisos y asignaciones por membresía;
- invitaciones registradas y checklist de onboarding; registrar una invitación
  no simula que su correo fue enviado;
- organigrama tenant-aware: unidades jerárquicas, cargos, responsables, líneas
  de reporte, asignaciones con vigencia y ámbitos organizacionales;
- auditoría separada para acciones del control plane;
- portafolio agregado sin exponer nómina, documentos, datos médicos o bancarios;
- `company_id` y relaciones compuestas en las raíces `employees` y
  `employee_groups`, como avance transicional hacia el aislamiento completo;
- RLS y helpers de autorización para el nuevo control plane.

La superficie web ya expone `/plataforma`: dashboard ejecutivo, cartera,
alta de clientes, detalle por empresa, asignación de roles, invitaciones
registradas, entitlements de módulos, onboarding, organigrama y auditoría
sanitizada. Sus mutaciones pasan por RPCs transaccionales de
`20260901121000_platform_management_rpcs.sql`; no usan `service_role` y no
duplican la auditoría desde la aplicación.

La cartera se consulta con búsqueda, filtros y paginación server-side; sus KPIs
provienen de una proyección agregada separada. El detalle carga únicamente la
pestaña solicitada, pagina las membresías y usa una proyección agregada para el
organigrama, sin transportar identidades laborales al control plane.

`20260901124000_platform_security_hardening.sql` hace explícito el límite de
MT-3A: authenticated conserva lectura filtrada, pero no puede saltarse los RPC
con DML directo; la auditoría es append-only, el último OWNER se protege bajo
concurrencia y la base rechaza cualquier dato laboral o workspace operativo de
una empresa distinta de ARCOTEX.

Cada empresa se provisiona con roles, módulos, pasos de onboarding y una unidad
organizacional raíz. ARCOTEX conserva el workspace habilitado; toda empresa nueva
queda en `ONBOARDING` con `workspace_enabled = false`.

## 3. Roles, módulos y organigrama

- Los roles globales administran GESTORA. Los roles de empresa son configurables
  y se resuelven por permisos, no por condicionales dispersos en la UI.
- `base_role` mantiene compatibilidad temporal con los cuatro roles históricos
  de ARCOTEX; la autoridad objetivo es `company_role_permissions`.
- Los features particulares se modelan con catálogo + entitlement + settings
  por empresa. Todo módulo debe validarse en servidor y RLS; la navegación es
  solo una representación visual del permiso.
- Mientras MT-3D no conecte esos entitlements con rutas, acciones y RLS, los
  módulos de un workspace ya operativo son de solo lectura. Se pueden preparar
  estados para clientes cuyo workspace continúa bloqueado.
- `organization_units` es el árbol organizacional. `employee_groups` conserva su
  responsabilidad independiente de clasificación para políticas laborales.
- Workera es un módulo/integración opcional. No debe condicionar la arquitectura
  global ni convertirse en fuente de identidad o autorización de GESTORA.

## 4. Gate de seguridad: segunda empresa operativa

MT-3A permite crear y configurar clientes, pero **no autoriza** operar sus datos
laborales. El dominio histórico aún contiene tablas, claves únicas, relaciones,
policies y consultas concebidas para ARCOTEX.

Antes de cambiar `workspace_enabled` a `true` para otra empresa, MT-3B–D debe:

1. incorporar y rellenar `company_id` en todas las tablas laborales pertinentes;
2. reemplazar claves y FKs globales por equivalentes tenant-aware, incluidas las
   relaciones compuestas necesarias;
3. aplicar RLS por empresa a todo el dominio y conservar el principio de mínimo
   privilegio para funciones y `service_role`;
4. propagar el tenant resuelto a consultas, comandos, sincronización, exports,
   Storage y jobs;
5. probar aislamiento negativo entre dos empresas en lectura, escritura,
   relaciones, RPCs, archivos y procesos asíncronos;
6. habilitar el workspace solo después de pasar ese gate completo.

No copiar datos de ARCOTEX, no depender de defaults implícitos y no presentar una
empresa en onboarding como si ya estuviera operativa.

## 5. Decisiones vigentes que no deben revertirse

- Evolucionar el repositorio actual; no reescribir ni duplicar la aplicación.
- Separar administración de plataforma y autorización de empresa.
- Mantener `workspace_enabled = false` como fail-closed para clientes nuevos.
- Mantener aislamiento en base de datos; los filtros de frontend no son una
  frontera de seguridad.
- Preservar la inmutabilidad/versionado de datos fuente y decisiones laborales.
- Conservar Workera en modo de lectura y sus credenciales solo server-side.
- Usar configuración por módulos y permisos, no ramas o forks por cliente.
- Mantener `organization_units` separado de `employee_groups`.
- No registrar secretos, payloads sensibles ni PII innecesaria en auditoría o
  observabilidad.

## 6. Decisiones antiguas reemplazadas o acotadas

- “La aplicación es solo para ARCOTEX” quedó reemplazado por una plataforma
  multiempresa. ARCOTEX sigue siendo el único workspace operativo durante la
  transición, no el límite futuro del producto.
- `SUPER_ADMIN` en `profiles.role` ya no representa al administrador global de
  GESTORA. Se conserva únicamente por compatibilidad del workspace; el control
  plane usa `platform_memberships`.
- La idea histórica de no implementar una jerarquía organizacional genérica fue
  válida para las primeras reglas laborales, pero quedó reemplazada para la
  plataforma: ahora existe `organization_units`. Esto no cambia el uso de
  `employee_groups` en reglas de horas extra y asistencia.
- Workera dejó de ser el centro conceptual del producto. Continúa como fuente e
  integración read-only para los procesos que la habiliten.

## 7. Próximos pasos

1. Ejecutar MT-3B–D por dominio, con migraciones pequeñas, backfill explícito y
   pruebas de cruce tenant antes de avanzar al siguiente dominio.
2. Hacer tenant-aware los jobs, archivos, exports e integraciones; evitar que un
   proceso server-side dependa de un tenant implícito.
3. Añadir observabilidad de plataforma con métricas agregadas y auditoría
   sanitizada, sin convertir el control plane en acceso silencioso a PII.
4. Conectar aceptación y envío de invitaciones, MFA para cuentas privilegiadas
   y administración avanzada de permisos sin relajar los gates existentes.
5. Solo después del gate de aislamiento, activar el primer cliente distinto de
   ARCOTEX y validar su onboarding extremo a extremo.

## 8. Regla para futuros agentes

Antes de cambiar código, conservar el estado del repositorio y leer `AGENTS.md`,
la sección **Pinned** de `README.md` y este documento. En Next.js, consultar la
guía local aplicable en `node_modules/next/dist/docs/`; no asumir APIs de otras
versiones. Toda afirmación de funcionalidad o prueba debe corresponder al estado
real del repositorio.
