# Inventario ejecutable de superficies

Estado: **implementado como gate de CI para HTTP, Server Actions, RPC y Storage**.
Las fuentes de verdad tipadas son
`src/lib/architecture/request-surfaces.ts` y
`src/lib/architecture/server-action-surfaces.ts`, además de
`src/lib/architecture/data-surfaces.ts`. Sus tests descubren los archivos
reales de `src`: una ruta/método, acción exportada, RPC u operación Storage
nueva, un archivo movido o un feature flag que deje de consultarse rompe la
suite hasta que exista una decisión explícita de seguridad.

El registro cubre las 20 superficies HTTP actuales y declara para cada una:

- dominio y tipo de entrada;
- autenticación y autorización efectiva;
- alcance tenant, incluida la deuda `LEGACY_ARCOTEX`;
- mutación, máximo de cuerpo e idempotencia/replay;
- control de abuso, auditoría, feature flag y clase de datos;
- bloqueos concretos antes de piloto o producción.

El registro adicional cubre exactamente los 16 archivos `use server` y sus 74
acciones exportadas. Registra autenticación, resolución tenant, validación,
máximo de archivos, abuso, auditoría y deuda de aislamiento laboral. El gate
también impide autorizar con roles/usuarios recibidos por `FormData`, exige que
la autorización preceda al parseo de bytes y evita que aparezca una familia de
uploads sin un máximo explícito de hasta 10 MiB.

El inventario de datos cubre exactamente 28 archivos consumidores, 87 nombres
RPC permitidos y 13 operaciones Storage agrupadas en 12 perfiles. Declara la
identidad de ejecución (sesión o capability `service_role`), alcance tenant,
autorización, auditoría, clase de datos, bucket y estado de cuarentena. Los RPC
dinámicos tienen una allowlist cerrada; un capability inexistente, un bucket
nuevo o una operación no registrada rompe CI.

## Lectura operativa actual

- Las dos entradas externas de archivos (Resend y Meta) están firmadas,
  limitadas a 512 KiB, poseen ledger idempotente y cuotas de negocio, y siguen
  apagadas. La cuarentena durable ya impide lectura, asociación y OCR antes de
  `CLEAN`; el inventario impide considerarlas habilitables mientras falten el
  proveedor antimalware real y rate limit en el borde.
- Los jobs usan `CRON_SECRET`; OCR y contabilidad poseen leases/fencing. Aún
  requieren observabilidad hospedada y alertas reales.
- La importación bancaria de Rendiciones ya tiene sesión, tenant, permiso,
  same-origin, límite de 2 MiB, cuota durable e idempotencia en base de datos.
- Las cuatro entregas de Rendiciones ya revalidan empresa/recurso en la base,
  consumen un límite distribuido y escriben auditoría atómica. Documentos,
  asistencia, lotes de nómina y maestro de proveedores aplican el mismo patrón
  antes de entregar bytes; documentos derivan empresa desde el trabajador y
  los tres exports heredados derivan explícitamente ARCOTEX. Todos sirven
  adjuntos sin signed URL. La cuota/auditoría quedó cerrada, pero esas tablas
  heredadas siguen siendo `LEGACY_ARCOTEX`, no multiempresa.
- Los callbacks de identidad dependen de controles de Auth hospedados que aún
  deben verificarse; la configuración local no es evidencia de producción.
- Las ocho mutaciones del control plane consumen antes de cualquier cambio una
  cuota horaria PostgreSQL por actor, empresa opcional y scope cerrado. La base
  revalida OWNER/ADMIN, AAL2 y coherencia empresa/recurso; un fallo bloquea la
  acción y el primer exceso de cada ventana queda en la bitácora sin PII.
- El reintento de Google Forms de colaciones ya no acepta payload/menú/nómina
  serializados por el navegador. Usa un token AES-256-GCM opaco, autenticado y
  con 30 minutos de vigencia; cualquier cambio o vencimiento obliga a volver a
  subir el documento. La acción sigue con deuda de rate limit y multiempresa.
- Los uploads laborales ahora requieren una reserva PostgreSQL por actor y
  trabajador, magic bytes, límite doble de 10 MiB y cuota distribuida de 30
  objetos/100 MiB por hora. Metadata y licencias se confirman por RPC atómico;
  los INSERT directos quedaron revocados. La descarga revalida empresa, rol,
  membresía y AAL2, consume una cuota durable y entrega bytes sin revelar signed
  URL. El proveedor antimalware y el sweeper de reservas vencidas siguen como
  brechas explícitas.

Este inventario no sustituye RLS, MFA, DAST, restore drill ni revisión humana.
Tampoco convierte una superficie con `blockers` en apta para marcha blanca.
