# Marcha blanca de asistencia ARCOTEX

## Alcance inicial

La primera marcha blanca se limita a ARCOTEX y reutiliza asistencia que ya fue
recolectada. No importa una semana nueva ni modifica la fuente Workera. La
ventana se elige como la semana lunes-domingo cerrada más reciente que tenga
sincronización exitosa para sus siete días.

El flujo permitido es revisión humana en sombra de asistencia diaria,
marcaciones faltantes, atrasos, salidas anticipadas, ausencias y horas extra.
No hay envío a remuneraciones, descuentos, pagos ni decisiones automáticas.

Quedan fuera de esta marcha blanca:

- nuevas empresas o expansión multicompañía;
- cargas documentales y licencias que requieran adjuntos;
- rendiciones, correo, WhatsApp, OCR e integraciones contables;
- cualquier escritura destructiva, semilla, limpieza o reinicio de la base.

## Control de entrada

Ejecutar desde un entorno con las credenciales de staging, sin imprimirlas:

```powershell
npm run readiness:arcotex-attendance
```

### Reparación controlada de estados preservados

Si el preflight detecta eventos vigentes guardados como
`UNKNOWN_EXTERNAL_STATUS` pero su valor crudo preservado corresponde a
`ACTIVO`, `INACTIVO` o `MODIFICADO`, se puede renormalizar un solo día sin
volver a consultar Workera. El comando usa la misma ruta versionada y auditada
de la sincronización normal; nunca sobrescribe una fila histórica.

Primero simular:

```bash
npm run repair:arcotex-attendance-statuses -- --date=2026-08-24
```

Aplicar solo después de revisar que `unsupportedUnknownEvents` sea cero:

```bash
npm run repair:arcotex-attendance-statuses -- --date=2026-08-24 --apply
```

El alcance está fijado al slug `arcotex`, exige una fecha calendario exacta y
se bloquea si existe otra corrida activa para ese día. Tras aplicar, exige que
no quede ningún estado desconocido vigente antes de cerrar la corrida como
exitosa.

Solo después de una reparación exitosa se reejecuta el motor para ese mismo
día:

```bash
npm run pilot:arcotex-attendance-day -- --date=2026-08-24
```

El comando entrega únicamente métricas agregadas y retorna error si la corrida
no termina en `SUCCEEDED`.

El control es de solo lectura y emite únicamente fechas, conteos y estados
agregados. El único resultado que permite abrir la revisión en sombra es
`READY_FOR_SHADOW_REVIEW`.

Si la semana calendario más reciente está incompleta, el control busca hacia
atrás hasta ocho semanas y selecciona la primera que tenga 7/7 días
sincronizados. Esto permite empezar con información ya recolectada sin ocultar
que existe una semana más nueva todavía incompleta.

## Foto agregada observada el 7 de septiembre de 2026

- La semana 31 de agosto–6 de septiembre tiene 2/7 días sincronizados.
- La última semana completamente recolectada es 24–30 de agosto.
- ARCOTEX tiene 98 trabajadores activos en la foto actual.
- La semana elegida contiene 396 marcaciones fuente vigentes y 195 registros
  diarios derivados vigentes.
- El motor de reglas terminó correctamente 2/7 días; cinco días quedaron en
  estado `PARTIAL`, con 186 fallos agregados.
- Hay 43 marcaciones faltantes pendientes de revisión humana.

Por lo tanto, la situación actual es `RULE_ENGINE_INCOMPLETE`: la fuente ya
está recolectada y no debe volver a importarse, pero la semana debe reprocesarse
de forma controlada y volver a pasar este control antes de abrir la marcha
blanca.

## Criterios para comenzar

1. El control selecciona una semana con 7/7 días sincronizados.
2. Hay marcaciones fuente y registros diarios derivados para esa semana.
3. La última ejecución del motor de reglas de cada día está en `SUCCEEDED`.
4. Se designan revisores humanos para resolver la cola sin automatizar efectos
   laborales ni de remuneraciones.
5. Se mantienen deshabilitadas todas las funciones fuera del alcance anterior.

## Criterios de pausa y reversa

Pausar la revisión si aparece un día sin sincronización, una ejecución de reglas
distinta de `SUCCEEDED`, un conteo inconsistente o un error de consulta. La
reversa consiste en detener la revisión en sombra; como este control no escribe
datos ni activa proveedores, no requiere borrar ni restaurar información.

## Comprobación de descarga para RR. HH.

Antes del primer uso operativo, RR. HH. debe descargar el libro desde el
dashboard de GESTORA usando el navegador y abrir esa copia guardada con
**Archivo → Abrir** en su Excel de escritorio. La respuesta declara el tipo
oficial de `.xlsx`; Excel 2013 o posterior puede abrirlo sin conversión a
`.xls`.

La comprobación queda aprobada solamente si:

1. el nombre descargado termina en `.xlsx` y el archivo no pesa cero bytes;
2. Excel abre el libro sin reparación, bloqueo ni advertencias;
3. aparecen `RESUMEN_NOMINA`, `CONTROL_PENDIENTES` y
   `MATRIZ_DIARIA_SABANA`;
4. la ventana y cantidad de trabajadores coinciden con el corte ARCOTEX;
5. la vista de impresión conserva orientación horizontal y una página de
   ancho, sin exigir una sola página de alto.

Si el navegador o Windows bloquean el archivo, registrar el mensaje exacto,
la versión de Excel y el tamaño descargado. No renombrar `.xlsx` a `.xls`: esa
conversión debe realizarla Excel y puede perder fórmulas si solo se cambia la
extensión o se usa un conversor genérico.
