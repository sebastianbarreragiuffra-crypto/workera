# Fase 4 — salida contable segura de Rendiciones

Estado: **implementada en modo seguro, no conectada a un ERP real**.

## Qué resuelve

Cuando Finanzas concilia una rendición como pagada, puede preparar una salida contable desde la pantalla **Rendiciones → Contabilidad**. PostgreSQL crea un snapshot inmutable con cabecera, centro de costo y líneas. El mismo comando repetido devuelve la misma salida: no duplica asientos ni eventos.

El snapshot excluye comprobantes, rutas de Storage, extracción OCR, números de cuenta y credenciales. Incluye solo los campos necesarios para construir un asiento. Lleva SHA-256 del contenido y una clave de idempotencia derivada de empresa + rendición + contrato de proveedor.

## Flujo

1. Una persona con `expenses.reconcile` o `expenses.manage` encola una rendición `PAID`.
2. El outbox queda `QUEUED`. Un worker service-role reclama lotes con `FOR UPDATE SKIP LOCKED`.
3. El claim emite un token de fencing y un lease de cinco minutos. Un worker antiguo no puede cerrar un lease vencido o renovado.
4. Un error transitorio usa backoff exponencial; máximo cinco intentos. Un lease huérfano se recupera automáticamente.
5. Cada transición queda en `expense_accounting_export_events`.

## Marcha blanca

`EXPENSE_ACCOUNTING_EXPORT_ENABLED=false` es el valor seguro. Con ese interruptor apagado, ni el disparo posterior a la respuesta ni `GET /api/jobs/expense-accounting` reclaman la cola.

El único adapter disponible es `dry-run`. Valida el contrato y devuelve una referencia `DRYRUN-*`, sin red ni efecto financiero. El CSV descargable está protegido contra Formula/CSV Injection y abre correctamente en Excel con UTF-8.

Para probar localmente:

- usar `EXPENSE_ACCOUNTING_EXPORT_ENABLED=true`;
- usar `EXPENSE_ACCOUNTING_PROVIDER=dry-run`;
- invocar el endpoint con el `CRON_SECRET` server-side ya usado por los jobs internos.

No se agregó un cron nuevo a `vercel.json`: la programación y el proveedor real requieren aprobación operativa, presupuesto, contrato de API, mapeo de cuentas y una ventana de rollback. La cola durable no depende de que ese cron exista todavía.

## Conectar un ERP real

Un nuevo adapter debe implementar `ExpenseAccountingAdapter`; nunca debe cambiar el RPC de encolado ni leer comprobantes. Requisitos mínimos: idempotency key reenviada al proveedor, timeout, clasificación retryable, credenciales en el gestor de secretos del ambiente, allowlist de host HTTPS, redacción de logs y prueba con una empresa piloto. La IA no decide cuentas, impuestos ni centros de costo.
