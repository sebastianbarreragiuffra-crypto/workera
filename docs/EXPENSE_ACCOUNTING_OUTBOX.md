# Fase 4 — salida contable segura de Rendiciones

Estado: **implementada y validada localmente en modo seguro; no conectada a un ERP real ni activada en staging**.

## Qué resuelve

Cuando Finanzas concilia una rendición como pagada, puede preparar una salida contable desde la pantalla **Rendiciones → Contabilidad**. PostgreSQL crea un snapshot inmutable con cabecera, centro de costo y líneas. El mismo comando repetido devuelve la misma salida: no duplica asientos ni eventos.

El snapshot excluye comprobantes, rutas de Storage, extracción OCR, números de cuenta y credenciales. Incluye solo los campos necesarios para construir un asiento. Lleva SHA-256 del contenido y una clave de idempotencia derivada de empresa + rendición + contrato de proveedor.

## Flujo

1. Una persona con `expenses.reconcile` o `expenses.manage` encola una rendición `PAID`.
2. El outbox queda `QUEUED`. Un worker service-role reclama lotes con `FOR UPDATE SKIP LOCKED`.
3. El claim emite un token de fencing y un lease de cinco minutos. Un worker antiguo no puede cerrar un lease vencido o renovado.
4. Solo `RATE_LIMIT` usa backoff exponencial y hasta cinco intentos. Timeouts,
   red, códigos desconocidos y cualquier resultado financiero incierto van a
   revisión humana. Un lease huérfano se recupera automáticamente.
5. Cada transición queda en `expense_accounting_export_events`.

El scheduler reserva además una sola ejecución global mediante
`expense_accounting_worker_runs`. Cada run usa un token de fencing, drena varios
lotes dentro de un presupuesto de tiempo y registra su resumen. Una ejecución
abandonada se cierra de forma estable antes de permitir la siguiente.
El worker reclama una salida por vez, entrega `AbortSignal` al adapter y reserva
tiempo para cerrar el lease; así un lote iniciado cerca del límite de Vercel no
deja trabajos posteriores retenidos. El heartbeat del watchdog considera solo
ejecuciones `CRON`: actividad manual o posterior a una respuesta no puede ocultar
un scheduler detenido.

## Fallos terminales y decisión humana

Un job que agota sus intentos entra en `FAILED`; el sistema no adivina si un
timeout alcanzó a crear el asiento en el ERP. En **Rendiciones → Contabilidad**,
otra persona con `expenses.manage` debe elegir una de tres resoluciones:

- reencolar con la misma idempotency key, después de confirmar en el ERP que el
  asiento no existe;
- confirmar el éxito indicando una referencia externa verificable; o
- cancelar, también confirmando que el asiento no existe.

La persona que preparó originalmente la salida no puede resolverla. El motivo,
la decisión y la referencia se guardan en eventos y auditoría. Hay un máximo de
tres replays manuales; nunca se crea una salida nueva para el mismo snapshot.
La DLQ se consulta por separado, ordenada por su última transición y paginada:
un fallo antiguo nunca queda tapado por cien salidas exitosas nuevas. La pantalla
muestra código operativo y proveedor, pero no mensajes internos ni payloads.

## Marcha blanca

`EXPENSE_ACCOUNTING_EXPORT_ENABLED=false` es el valor seguro. Con ese interruptor
apagado, la interfaz bloquea nuevos encolados y ni el disparo posterior a la
respuesta ni `GET /api/jobs/expense-accounting` reclaman la cola. PostgreSQL
aplica además un segundo interruptor por empresa en
`company_modules.settings.expense_accounting_export_enabled`: una llamada directa
al RPC tampoco puede saltarse la pausa. El modo queda visible para Contabilidad.
La empresa debe seguir activa; suspenderla retiene el backlog aunque el flag haya
quedado encendido. El watchdog conserva una lectura de salud aun con el kill-switch
global apagado y distingue backlog pausado de recuperación técnica.
Cuando un ambiente ya debe estar activo,
`EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED=true` hace que cron/watchdog respondan
503 si el flag de exportación se pierde.

El único adapter disponible es `dry-run`. Valida el contrato y devuelve una referencia `DRYRUN-*`, sin red ni efecto financiero. El CSV descargable está protegido contra Formula/CSV Injection y abre correctamente en Excel con UTF-8.

Para probar localmente:

- usar `EXPENSE_ACCOUNTING_EXPORT_ENABLED=true`;
- usar `EXPENSE_ACCOUNTING_PROVIDER=dry-run`;
- habilitar `expense_accounting_export_enabled=true` solo en la fila del módulo
  `expenses` de la empresa piloto; y
- invocar el endpoint con el `CRON_SECRET` server-side ya usado por los jobs internos.

`vercel.json` programa un catch-up diario y un watchdog diario. Esa cadencia es
compatible con Vercel Hobby según la
[documentación oficial de Vercel Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing);
no satisface un objetivo de frescura de 30 minutos.
Para una marcha blanca real se debe usar Vercel Pro/Enterprise con una cadencia
aprobada o un scheduler externo, y un monitor independiente que alerte cuando el
watchdog devuelva 5xx o deje de ejecutarse. El disparo posterior a la respuesta
solo reduce latencia: la cola durable y el cron siguen siendo la recuperación.

Variables operativas opcionales y acotadas:

- `EXPENSE_ACCOUNTING_BATCH_SIZE` (default 10, máximo 25);
- `EXPENSE_ACCOUNTING_MAX_BATCHES` (default 4, máximo 10);
- `EXPENSE_ACCOUNTING_MAX_RUNTIME_MS` (default 45 s, máximo 50 s);
- `EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS` (default 10 s, máximo 30 s y siempre con
  1 s de reserva para cerrar el lease);
- `EXPENSE_ACCOUNTING_WATCHDOG_STALE_SECONDS` (default 26 h, máximo 7 días); y
- `EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED` (false hasta activar el canario).

## Activación controlada

1. Aplicar las migraciones en un ambiente saneado y conservar la base/Storage
   anterior para rollback.
2. Mantener `EXPENSE_ACCOUNTING_PROVIDER=dry-run`, habilitar el flag de entorno y
   activar únicamente el canario mediante el RPC de control plane. El RPC exige
   OWNER/ADMIN de plataforma, incrementa `settings_version` y escribe
   `platform_audit_log` en la misma transacción:

   ```sql
   select public.platform_set_expense_accounting_pilot(
     '<UUID_EMPRESA_PILOTO>',
     true,
     'Activación controlada de marcha blanca'
   );
   ```

   Para pausar, ejecutar el mismo RPC con `false` y un motivo. La pausa bloquea
   inserts, replays manuales y el claim de backlog anterior de esa empresa. La
   interfaz mantiene disponibles confirmar/cancelar, pero elimina el replay.
3. Configurar `CRON_SECRET`, cambiar `EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED`
   a `true`, verificar manualmente ambos endpoints y conectar el monitor
   independiente.
4. Provocar de forma controlada un retry, un lease vencido y un `FAILED`; probar
   las tres resoluciones maker-checker.
5. Solo después aprobar cuentas, impuestos, centros de costo y contrato de
   idempotencia del ERP real.

## Conectar un ERP real

Un nuevo adapter debe implementar `ExpenseAccountingAdapter`; nunca debe cambiar
el RPC de encolado ni leer comprobantes. Requisitos mínimos: idempotency key
reenviada al proveedor, respeto de `AbortSignal`, timeout, clasificación
de errores, credenciales en el gestor de secretos del ambiente, allowlist de host
HTTPS, redacción de logs y prueba con una empresa piloto. Un timeout genérico se
considera resultado externo incierto y va a reconciliación humana. La allowlist
automática actual contiene exclusivamente `RATE_LIMIT`; incorporar otro código
requiere una migración forward, prueba de que no hubo efecto financiero y revisión
del runbook. El booleano de un adapter nunca amplía por sí solo esa política.
La IA no decide cuentas, impuestos ni centros de costo.
