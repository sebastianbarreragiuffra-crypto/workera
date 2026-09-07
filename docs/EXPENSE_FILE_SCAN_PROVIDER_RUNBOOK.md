# Runbook del proveedor antimalware para Rendiciones

Estado: **adapter candidato implementado; integración no aprobada ni habilitada**.

El candidato técnico es Cloudmersive Advanced Virus Scan usando exclusivamente
un Private Tenant o endpoint dedicado. El código rechaza los hosts públicos
`api.cloudmersive.com` y `testapi.cloudmersive.com`. Esta elección es reversible
y no cierra por sí sola el gate global `ANTIMALWARE_PROVIDER`.

## Condiciones previas de aprobación

Security, Privacy/Legal y el responsable comercial deben registrar fuera del
repositorio:

- contrato, DPA, subprocesadores, residencia efectiva y retención de archivos;
- SLA, capacidad, límites, soporte e incidente/breach notification;
- hostname exacto del tenant privado y allowlist de egreso;
- prohibición de usar datos reales durante canarios;
- dueño del monitoreo, escalamiento y rollback.

No habilitar mientras alguno de esos puntos esté pendiente. Referencias del
proveedor: [API de Virus Scan](https://api.cloudmersive.com/docs/virus.asp),
[seguridad](https://cloudmersive.com/security) y
[DPA](https://www.cloudmersive.com/data-processing-dpa).

## Configuración fail-closed

Guardar secretos únicamente en el gestor del ambiente. Nunca en archivos
versionados ni logs.

```text
EXPENSE_FILE_SCAN_PROVIDER=cloudmersive-advanced
CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN=https://<tenant-privado-aprobado>
CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME=<hostname-exacto-aprobado>
CLOUDMERSIVE_API_KEY=<secret-manager>
EXPENSE_FILE_SCAN_REQUEST_TIMEOUT_MS=15000
EXPENSE_FILE_SCAN_MAX_FILES_PER_RUN=10
EXPENSE_FILE_SCAN_MAX_RUNTIME_MS=45000
EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED=true
EXPENSE_FILE_SCAN_ENABLED=true
EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED=true
```

Orden de activación:

1. configurar origen, hostname aprobado, secreto, capacidad y timeout con ambos
   flags en `false`; además fijar el mismo hostname en la allowlist de egreso;
2. aprobar y activar `EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED`;
3. resolver y probar un deadline extremo a extremo para RPC, Storage y proveedor,
   sin depender solo del presupuesto de admisión del batch;
4. ejecutar canarios sintéticos con los canales externos aún apagados;
5. activar el worker y comprobar el cron, métricas y alertas;
6. activar el monitor esperado;
7. evaluar por separado correo y WhatsApp con un canario mínimo.

El inventario `readiness:staging-data` exige que proveedor, transferencia,
worker y monitor permanezcan apagados durante la preparación. Por eso, cambiar
esos valores para un canario en el staging compartido produce
`CONFIGURATION_DRIFT` de forma deliberada y es **NO-GO**. El primer canario debe
ejecutarse en un Preview aislado; cualquier transición posterior del preflight
requiere una aprobación registrada y un cambio separado, revisable y reversible.

El worker reclama de a un archivo para no dejar leases adicionales esperando,
pero continúa secuencialmente hasta el máximo configurado y solo mientras quepa
un timeout completo dentro de 45 segundos. Se detiene al primer fallo. La
restricción actual decide si inicia otro archivo, pero todavía no cancela una
descarga o RPC de Supabase lenta; por eso no autoriza el canario alojado ni
garantiza por sí sola terminar antes de `maxDuration=60`.
La cadencia diaria sirve únicamente para canarios de bajo volumen; antes de abrir
un canal se debe demostrar capacidad y contratar/configurar un scheduler o
worker con frecuencia acorde al SLA y a `Retry-After`.

`401/403` se reintenta con backoff y dispara `503` para alertar una credencial
mal rotada; red, timeout, `408`, `429` y `5xx` también reintentan, respetando
`Retry-After` entre 30 y 3.600 segundos. La base conserva un máximo de tres
intentos por archivo: antes del canario alojado debe existir una operación
fenced y auditada de requeue para recuperar `SCAN_FAILED` tras corregir un fallo
global. Todo archivo sin veredicto permanece bloqueado.

## Canarios obligatorios

Usar únicamente artefactos sintéticos sin PII:

- PDF, JPEG y PNG limpios;
- archivo EICAR autorizado por Security para comprobar rechazo;
- PDF con script, ejecutable incrustado o formato no permitido;
- credencial inválida, `429` con `Retry-After`, timeout, `5xx` y respuesta
  malformada/sobredimensionada;
- backlog mayor que una ejecución y lease vencida recuperada;
- invocación de cron con secreto correcto, incorrecto y método/ruta cercanos.

Verificar que no aparezcan bytes, nombres originales, hashes, identificadores de
persona, nombres de virus ni respuestas crudas en logs o base. Solo se admiten
correlation ID, conteos agregados y códigos sanitizados.

## Monitoreo y rollback

Alertar por cualquier `503` del cron (drift o fallo del batch), fallos terminales, crecimiento/edad de la cola,
latencia, `429`, `5xx` y rechazo anómalo. El breaker compartido entre instancias
todavía no existe; la cuarentena durable conserva el fail-closed, pero antes de
volumen real deben añadirse el breaker/health state compartido y el requeue
operacional, y probarse la capacidad contratada.

Rollback seguro:

1. apagar primero correo y WhatsApp para detener ingresos externos;
2. mantener el scanner activo hasta vaciar o estabilizar la cola;
3. si el proveedor es inseguro o está comprometido, apagar el scanner y dejar
   los archivos en cuarentena;
4. nunca cambiar a `fixture`, nunca marcar en masa como `CLEAN` y nunca publicar
   archivos sin un veredicto válido;
5. registrar alcance, evidencia y decisión antes de reactivar.

Los documentos laborales están fuera del adapter de Rendiciones. El gate global
`ANTIMALWARE_PROVIDER` seguirá abierto hasta que ese flujo tenga cobertura y
evidencia propias.
