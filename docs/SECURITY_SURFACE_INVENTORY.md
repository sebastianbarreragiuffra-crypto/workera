# Inventario ejecutable de superficies

Estado: **implementado como gate de CI para Route Handlers**. La fuente de
verdad tipada es `src/lib/architecture/request-surfaces.ts`; su test descubre
los archivos reales de `src/app`, elimina route groups de Next.js y compara
cada par método + URL. Una ruta nueva, un método nuevo, un archivo movido o un
feature flag que deje de consultarse rompe la suite hasta que exista una
decisión explícita de seguridad.

El registro cubre las 20 superficies HTTP actuales y declara para cada una:

- dominio y tipo de entrada;
- autenticación y autorización efectiva;
- alcance tenant, incluida la deuda `LEGACY_ARCOTEX`;
- mutación, máximo de cuerpo e idempotencia/replay;
- control de abuso, auditoría, feature flag y clase de datos;
- bloqueos concretos antes de piloto o producción.

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
- Las descargas y exportaciones siguen con deuda explícita: rate limit de
  aplicación y auditoría de acceso/exportación. Las laborales, además, siguen
  limitadas a ARCOTEX hasta completar el aislamiento multiempresa.
- Los callbacks de identidad dependen de controles de Auth hospedados que aún
  deben verificarse; la configuración local no es evidencia de producción.

Este inventario no sustituye RLS, MFA, DAST, restore drill ni revisión humana.
Tampoco convierte una superficie con `blockers` en apta para marcha blanca.
