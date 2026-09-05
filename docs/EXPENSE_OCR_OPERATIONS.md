# Operación del OCR de Rendiciones

## Flujo de procesamiento

1. Asociar un comprobante crea un job durable en PostgreSQL.
2. La Server Action responde al usuario y usa `after()` para intentar procesar
   la cola sin bloquear el teléfono.
3. Si esa ejecución best-effort se interrumpe, el lease expira y el cron diario
   de `/api/jobs/expense-ocr` recupera el trabajo pendiente.
4. Los errores retryable se reencolan con máximo de tres intentos; la revisión
   humana sigue siendo obligatoria cuando hay discrepancias o baja confianza.

La cola en base de datos es la fuente de verdad. `after()` mejora la latencia,
pero nunca se usa como garantía de entrega.

## Autenticación

- El endpoint acepta únicamente `GET /api/jobs/expense-ocr`.
- Proxy y Route Handler validan el mismo `Authorization: Bearer CRON_SECRET`.
- `CRON_SECRET` debe tener al menos 32 bytes aleatorios. Generación sugerida:
  `openssl rand -base64 48`.
- El secreto se almacena solo en el gestor de secretos del ambiente, nunca en
  Git, navegador, logs ni variables `NEXT_PUBLIC_*`.

## Frecuencia y plan de hosting

`vercel.json` deja un respaldo diario a las 10:30 UTC. Esta frecuencia evita
que un proyecto con un plan que solo admite cron diario rechace el despliegue.
El procesamiento normal ocurre al asociar el comprobante mediante `after()`.

Si el ambiente dispone de cron frecuente, se puede reducir el intervalo a
5–10 minutos después de verificar límites y costo. No debe quitarse el lease,
la idempotencia ni el respaldo diario.

## Variables

- `EXPENSE_OCR_ENABLED=true`
- `EXPENSE_OCR_PROVIDER=azure-document-intelligence`
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://...`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY=...`
- `EXPENSE_OCR_REQUEST_TIMEOUT_MS=15000`
- `CRON_SECRET=<valor aleatorio de al menos 32 bytes>`

Con `EXPENSE_OCR_ENABLED` distinto de `true`, tanto el disparo inmediato como
el worker permanecen fail-closed.

## Alertas mínimas antes de producción

- jobs `FAILED` y jobs esperando más de 30 minutos;
- crecimiento de la cola y leases vencidos;
- respuestas 401/429/5xx del proveedor;
- gasto mensual por empresa y tasa de revisión humana;
- invocaciones 401 repetidas al endpoint de cron (WAF/rate limit externo).
