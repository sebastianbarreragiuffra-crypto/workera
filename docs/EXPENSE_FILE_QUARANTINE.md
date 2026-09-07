# Cuarentena de archivos de Rendiciones

Estado: **frontera durable, worker provider-agnostic y adapter candidato para
Cloudmersive Advanced sobre tenant privado implementados localmente; contrato,
transferencia externa y conectores permanecen sin aprobar y apagados**.

La migración `20260905100000_expense_file_quarantine.sql` cambia el flujo para
que recibir un archivo no equivalga a confiar en él. Correo y WhatsApp entran
siempre como `PENDING_SCAN`; ni una sesión normal ni `service_role` pueden
adjuntarlos, entregarlos mediante Storage, usarlos para enviar una rendición o
encolarlos en OCR antes de un veredicto `CLEAN`.

## Estados y autoridad

- `VALIDATED_INTERNAL`: carga web/cámara que pasó tamaño, MIME y magic bytes.
  Es una procedencia explícita para el piloto interno, **no** un veredicto
  antivirus.
- `PENDING_SCAN` / `SCANNING`: cuarentena externa, con disponibilidad, máximo
  de tres intentos, lease por worker y recuperación de lease vencida.
- `CLEAN`: único veredicto de un scanner que libera un archivo externo.
- `REJECTED`: archivo bloqueado por veredicto terminal.
- `SCAN_FAILED`: el scanner no pudo dar un veredicto dentro de la política de
  reintentos; permanece bloqueado y requiere operación humana.

Solo `service_role` puede ejecutar `claim_expense_file_scans`,
`complete_expense_file_scan`, `fail_expense_file_scan` y
`reclaim_stale_expense_file_scans`. El cierre exige el mismo UUID de worker que
obtuvo la lease; los mensajes guardados son códigos sanitizados de hasta 80
caracteres, no contenido del archivo ni respuestas crudas del proveedor.

El runtime en `src/lib/expense-file-scan/` ya consume esas cuatro RPC: recupera
leases vencidas, reclama con `SKIP LOCKED`, descarga desde el bucket privado,
revalida tamaño, MIME y SHA-256, entrega bytes al contrato `ExpenseFileScanner`
y completa o reintenta con códigos allowlisted. La ruta de cron
`/api/jobs/expense-file-scan` exige `CRON_SECRET` y un flag independiente.

Existe `FixtureExpenseFileScanner` para canarios sintéticos CLEAN/REJECTED. Su
configuración exige doble opt-in y rechaza siempre `NODE_ENV=production`; no es
un antivirus, no permite cerrar el gate y no autoriza habilitar canales reales.

El adapter `CloudmersiveAdvancedScanner` exige un origen HTTPS y un hostname
aprobado idéntico para el tenant privado,
rechaza los hosts públicos multi-tenant, usa nombre sintético, timeout y sin
redirects, limita la respuesta y reduce cualquier detalle del proveedor a códigos
genéricos. También exige el opt-in separado
`EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED=true`. Su presencia en código no
constituye aprobación de privacidad, seguridad ni compras.

## Defensas independientes

La seguridad no depende de una sola comprobación de UI:

1. un trigger asigna cuarentena según el origen, aunque un RPC olvide hacerlo;
2. las funciones de lectura de Storage niegan bytes no liberados;
3. un trigger impide crear un comprobante desde una captura no liberada;
4. OCR solo se encola para `VALIDATED_INTERNAL` o `CLEAN`;
5. otro trigger impide enviar una rendición con un comprobante obligatorio en
   cuarentena;
6. la bandeja muestra el estado pero no ofrece abrir o asociar el archivo.

Los objetos siguen en el bucket privado existente para que el futuro worker
pueda inspeccionarlos. Un veredicto `REJECTED` no los publica ni los elimina en
silencio: la política de retención, evidencia forense y borrado debe definirse
con el proveedor y el responsable de seguridad.

## Siguiente gate

Antes de habilitar `EXPENSE_EMAIL_CAPTURE_ENABLED` o
`EXPENSE_WHATSAPP_CAPTURE_ENABLED` en un ambiente con datos reales se requiere:

- aprobar o descartar el tenant privado candidato, incluyendo DPA,
  subprocesadores, residencia, retención y SLA;
- configurar allowlist de egreso y monitoreo compartido; el circuit breaker
  durable y el requeue operacional de fallos globales siguen pendientes;
- decidir si cargas web/cámara también migran de `VALIDATED_INTERNAL` a
  cuarentena obligatoria para el alcance del piloto;
- definir SLA, retención de rechazados y alertas por backlog/fallo terminal;
- probar canarios limpios e inofensivos de detección en staging aislado.

El procedimiento de aprobación y despliegue está en
`docs/EXPENSE_FILE_SCAN_PROVIDER_RUNBOOK.md`. La prueba pgTAP
`072_expense_file_quarantine.sql` cubre las invariantes de base;
las pruebas de worker agregan canarios limpio/rechazado, checksum alterado,
configuración fail-closed y sanitización de errores. El gate sigue en NO-GO
hasta aprobar, conectar y verificar un proveedor real. Además, el gate global
`ANTIMALWARE_PROVIDER` no puede cerrarse con cobertura exclusiva de Rendiciones:
los documentos laborales requieren una decisión y cobertura equivalentes.
