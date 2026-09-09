# Replay shadow offline de asistencia ARCOTEX

## Propósito

`scripts/arcotex-shadow-replay.mts` verifica, sin conectarse a servicios, una
foto semanal que ya fue reducida a métricas agregadas. El control comprueba el
alcance autorizado de 45 personas, la ventana lunes-domingo 7/7, los estados de
sincronización y reglas, la conciliación independiente de totales y la ausencia
de duplicados vigentes, eventos fuera del padrón, identidades ambiguas, estados
sin resolver, fallos de reglas y personas sin horario.

El comando no extrae datos, no reejecuta el motor de asistencia, no consulta
Workera, no importa módulos de la aplicación o Supabase y no escribe archivos
ni base de datos. Su salida contiene únicamente conteos, booleanos y códigos de
bloqueo. No cambia por sí sola el veredicto de staging ni autoriza activar
`WORKERA_SYNC_ENABLED`.

## Ejecución

Con un artefacto agregado autorizado fuera del repositorio:

```powershell
node --import=tsx scripts/arcotex-shadow-replay.mts --input "C:\ruta\semana.aggregate.json"
```

El proceso devuelve código `0` únicamente con
`READY_FOR_SHADOW_REVIEW`. Cualquier argumento, archivo, esquema, valor o
control inválido produce `BLOCKED` y código `1`. Los errores son códigos
estáticos: nunca reflejan la ruta ni el contenido de entrada.

Para ejecutar la batería sintética propia:

```powershell
node --import=tsx --test scripts/arcotex-shadow-replay.test.mts
```

## Contrato de entrada

El archivo debe ser JSON UTF-8, regular, no simbólico y de hasta 128 KiB. El
esquema es cerrado: no admite campos adicionales ni texto libre.

- `schemaVersion`: `ARCOTEX_SHADOW_REPLAY_V1`.
- `scope`: `ARCOTEX`.
- `mode`: `OFFLINE_SANITIZED_AGGREGATES`.
- `workeraSyncEnabled`: debe ser `false`.
- `week`: `start` y `end` en formato `YYYY-MM-DD`; debe abarcar exactamente un
  lunes a domingo.
- `roster`: conteos `expectedEmployees` y `observedEmployees`, ambos 45, más
  `expectedScopeSha256` y `observedScopeSha256`, dos huellas SHA-256 que deben
  coincidir.
- `days`: exactamente siete objetos, uno por fecha. Cada uno declara
  `syncStatus`, `ruleEngineStatus`, `inputFresh` y los conteos agregados
  `employeesProcessed`, `rawEvents`, `derivedRecords`,
  `duplicateCurrentEvents`, `outsideRosterEvents`,
  `ambiguousIdentityMatches`, `unresolvedSourceStatuses`, `ruleFailures` y
  `withoutSchedule`.
- `reconciliation`: suma independiente de cada conteo diario. Debe coincidir
  campo por campo con lo recalculado por el verificador.

Los únicos estados permitidos son `SUCCEEDED`, `PARTIAL`, `FAILED`, `RUNNING`,
`MISSING` y `OTHER`; los siete días deben estar en `SUCCEEDED` y con entrada
fresca para aprobar. Todos los conteos de anomalías deben ser cero. Debe existir
al menos una marcación fuente y un registro derivado en la semana.

No incluir nombres, RUT, correos, teléfonos, direcciones, UUID de personas o
empresas, payloads crudos, tokens, credenciales ni observaciones. Las huellas de
alcance se usan sólo para comparar el conjunto esperado con el observado y no
se copian a la salida. Los tests usan fixtures sintéticos y una reproducción
sólo con los totales, fechas y estados agregados ya versionados en
`docs/ARCOTEX_ATTENDANCE_PILOT.md`; nunca contienen filas ni PII y no son
evidencia operativa.

## Procedimiento seguro

1. Mantener `WORKERA_SYNC_ENABLED=false` y no ejecutar una nueva recolección.
2. Generar el JSON mediante un proceso de origen separado, autorizado y
   auditado que reduzca la semana ya capturada al contrato anterior. Ese proceso
   debe emitir directamente sólo conteos, estados y las dos huellas unidireccionales
   de alcance; no debe exportar primero filas, identificadores ni payloads a un
   archivo intermedio. También debe calcular `reconciliation` de manera
   independiente; este módulo no accede a ese origen.
3. Guardar el artefacto fuera de Git y aplicar la retención aprobada. No copiar
   datos reales al repositorio ni ampliar el esquema para depurar un rechazo.
4. Ejecutar el comando offline y conservar sólo su JSON agregado si se necesita
   evidencia. Ante `BLOCKED`, detener la revisión y resolver el código indicado
   en el proceso propietario del dato.

## Límite de la evidencia

El replay demuestra consistencia interna del artefacto agregado, no la verdad
de la extracción que lo produjo. Antes de usar un resultado aprobado en una
decisión de marcha blanca, un responsable debe acreditar la procedencia de la
foto, el padrón autorizado y que la generación ocurrió sobre la semana ya
capturada, sin nueva llamada al proveedor. Los controles hospedados de Auth,
RLS, disponibilidad, secretos y aislamiento siguen perteneciendo a staging.
