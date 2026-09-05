# Cuarentena de archivos de Rendiciones

Estado: **frontera durable implementada y probada localmente; proveedor
antimalware no seleccionado y conectores externos apagados**.

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

- elegir y contratar el scanner/antimalware o CDR;
- implementar su adapter server-only con timeout, egress allowlisted y circuit
  breaker;
- ejecutar el worker sobre estas RPC, sin saltarse la cuarentena;
- definir SLA, retención de rechazados y alertas por backlog/fallo terminal;
- probar canarios limpios e inofensivos de detección en staging aislado.

La prueba pgTAP `072_expense_file_quarantine.sql` cubre 38 invariantes y la
batería completa de 72 archivos/1.578 checks pasó en una pila Supabase aislada.
