# Inventario ejecutable de superficies

Estado: **implementado como gate de CI para Route Handlers y Server Actions**.
Las fuentes de verdad tipadas son
`src/lib/architecture/request-surfaces.ts` y
`src/lib/architecture/server-action-surfaces.ts`. Sus tests descubren los
archivos reales de `src/app`: una ruta/método o acción exportada nueva, un
archivo movido o un feature flag que deje de consultarse rompe la suite hasta
que exista una decisión explícita de seguridad.

El registro cubre las 20 superficies HTTP actuales y declara para cada una:

- dominio y tipo de entrada;
- autenticación y autorización efectiva;
- alcance tenant, incluida la deuda `LEGACY_ARCOTEX`;
- mutación, máximo de cuerpo e idempotencia/replay;
- control de abuso, auditoría, feature flag y clase de datos;
- bloqueos concretos antes de piloto o producción.

El registro adicional cubre exactamente los 16 archivos `use server` y sus 75
acciones exportadas. Registra autenticación, resolución tenant, validación,
máximo de archivos, abuso, auditoría y deuda de aislamiento laboral. El gate
también impide autorizar con roles/usuarios recibidos por `FormData`, exige que
la autorización preceda al parseo de bytes y evita que aparezca una familia de
uploads sin un máximo explícito de hasta 10 MiB.

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
  consumen un límite distribuido y escriben auditoría atómica. Las descargas
  laborales aún tienen esa deuda y, además, siguen limitadas a ARCOTEX hasta
  completar el aislamiento multiempresa.
- Los callbacks de identidad dependen de controles de Auth hospedados que aún
  deben verificarse; la configuración local no es evidencia de producción.
- El reintento de Google Forms de colaciones ya no acepta payload/menú/nómina
  serializados por el navegador. Usa un token AES-256-GCM opaco, autenticado y
  con 30 minutos de vigencia; cualquier cambio o vencimiento obliga a volver a
  subir el documento. La acción sigue con deuda de rate limit y multiempresa.

Este inventario no sustituye RLS, MFA, DAST, restore drill ni revisión humana.
Tampoco convierte una superficie con `blockers` en apta para marcha blanca.
