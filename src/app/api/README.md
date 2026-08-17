# app/api/

Route Handlers server-side de Next.js. Es la capa "Backend" del flujo `Frontend → Backend → Workera API`.

Endpoints previstos (se agregan fase a fase, no todos de una vez):
- `POST /api/sync/workera` — dispara sincronización del día anterior (Fase 5).
- `POST /api/overtime/approve` — aprueba/rechaza horas extra, valida server-side y escribe auditoría (Fase 7).
- `POST /api/workera/authorize-overtime` — reenvía la aprobación a Workera si su API lo permite (Fase 8).
- `POST /api/exports/weekly` — genera el Excel semanal (Fase 10).

Ningún Route Handler debe confiar en IDs o roles enviados por el cliente sin volver a validarlos contra la sesión de Supabase.
