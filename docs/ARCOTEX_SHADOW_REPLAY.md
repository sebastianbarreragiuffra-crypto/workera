# Verificador de consistencia offline ARCOTEX

## Propósito y límite del resultado

`scripts/arcotex-shadow-replay.mts` verifica, sin conectarse a servicios, una
foto semanal que un productor previo redujo a métricas agregadas. Comprueba el
alcance de 45 personas, la ventana lunes-domingo 7/7, estados, conciliación y
ausencia de duplicados vigentes, eventos fuera del padrón, identidades
ambiguas, estados sin resolver, fallos de reglas y personas sin horario.

El resultado positivo es `CONSISTENT_OFFLINE_EVIDENCE`: significa sólo que el
JSON es internamente consistente con estos controles. No significa
`READY_FOR_SHADOW_REVIEW`, no prueba que el flag real esté apagado y no acredita
por sí solo al productor ni la procedencia de los datos. El preflight hospedado
`npm run readiness:arcotex-attendance` es el único control de este flujo que
puede emitir `READY_FOR_SHADOW_REVIEW`, una vez resueltos también sus gates de
staging.

Este módulo no extrae datos, no reejecuta el motor de asistencia, no consulta
Workera o Supabase y no escribe archivos ni base de datos. Importa de la
aplicación únicamente la constante versionada
`ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256`; no importa servicios ni lógica de
acceso a datos.

## Ejecución

Con un artefacto agregado autorizado fuera del repositorio:

```powershell
node --import=tsx scripts/arcotex-shadow-replay.mts --input "C:\ruta\semana.aggregate.json"
```

El proceso devuelve código `0` únicamente con
`CONSISTENT_OFFLINE_EVIDENCE`. Cualquier argumento, archivo, esquema, valor o
control inválido produce `BLOCKED` y código `1`. Los errores usan códigos
estáticos y no reflejan la ruta ni el contenido de entrada.

Para ejecutar la batería propia, que usa sólo fixtures sintéticos o agregados
ya versionados:

```powershell
node --import=tsx --test scripts/arcotex-shadow-replay.test.mts
```

## Contrato de entrada V2

El archivo debe ser JSON UTF-8, regular, no simbólico y de hasta 128 KiB. Se
abre una vez; tamaño, identidad y metadatos se cotejan antes y después de la
lectura acotada para bloquear sustituciones o cambios concurrentes. El esquema
es cerrado: no admite campos adicionales ni texto libre.

- `schemaVersion`: `ARCOTEX_SHADOW_REPLAY_V2`.
- `candidateSha`: SHA completo de Git, 40 caracteres hexadecimales minúsculos.
- `scope`: `ARCOTEX`.
- `mode`: `OFFLINE_SANITIZED_AGGREGATES`.
- `workeraSyncEnabledDeclared`: declaración del productor; debe ser `false`
  para que el artefacto sea consistente. No es lectura ni prueba del flag
  desplegado.
- `week`: `start` y `end` en formato `YYYY-MM-DD`; debe abarcar exactamente un
  lunes a domingo cerrado.
- `roster`: `expectedEmployees` y `observedEmployees`, ambos 45, y
  `observedScopeSha256`. Esta huella se compara directamente con
  `ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256`; el input no puede declarar su
  propio hash esperado.
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
fresca para obtener consistencia. Todos los conteos de anomalías deben ser cero
y debe existir al menos una marcación fuente y un registro derivado.

No incluir nombres, RUT, correos, teléfonos, direcciones, UUID de personas o
empresas, payloads crudos, tokens, credenciales ni observaciones. El test de la
foto conocida usa sólo fecha, estados y totales agregados ya versionados en
`docs/ARCOTEX_ATTENDANCE_PILOT.md`; no contiene filas ni PII y sigue dando
`BLOCKED`.

## Identidad canónica de la evidencia

Después de validar el esquema, el comando ordena las claves JSON de forma
lexicográfica y los días por fecha, serializa sin espacios en UTF-8 y calcula
SHA-256.
La salida liga siempre un artefacto válido —también si queda `BLOCKED`— con:

- `candidateSha`;
- `week.start` y `week.end`;
- `artifactSha256`, huella del artefacto canónico completo.

El módulo valida el formato completo de `candidateSha`, pero no resuelve Git ni
demuestra que ese commit sea el candidato aprobado. Esa comparación pertenece
al gate externo de procedencia.

Por eso cambios de espacios, orden de claves u orden de días conservan la misma
huella, mientras que cambiar el candidato, la semana o cualquier métrica la
cambia. La salida no incluye la huella del padrón ni identificadores laborales.

## Productor pendiente y procedimiento seguro

Esta rama no implementa ni acredita al productor del JSON. Hasta que exista un
productor confiable, revisado y ejecutado en un entorno autorizado, un archivo
armado manualmente sirve para pruebas pero no como evidencia de marcha blanca.
Ese productor pendiente deberá:

1. operar sobre la semana ya capturada, sin nueva llamada al proveedor y con
   `WORKERA_SYNC_ENABLED=false` verificado por un gate independiente;
2. agregar en el origen y emitir directamente sólo los campos del contrato,
   sin exportar antes filas, identificadores o payloads a archivos intermedios;
3. calcular `observedScopeSha256` desde los códigos resueltos y
   `reconciliation` por una ruta independiente;
4. acreditar procedencia, candidato y custodia del artefacto fuera de Git.

Una vez disponible, se ejecuta este verificador offline y se conserva sólo su
salida agregada si la política lo requiere. `BLOCKED` detiene el flujo. Un
resultado consistente pasa después al preflight hospedado; no lo sustituye.
