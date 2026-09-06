# Traspaso: pre-nómina multiempresa

Fecha del punto de control: 2026-09-06  
Rama: `codex/prenomina-marcha-blanca`  
Commit base funcional: `d13374f` (`docs: checkpoint workforce tenant selection`)

## Decisiones confirmadas

- Todo el historial actual de `reporting_periods` corresponde a Arcotex.
- Arcotex será la primera empresa del holding, pero el servicio debe admitir otras empresas con cambios pequeños y aislados.
- Dos empresas pueden usar el mismo rango de fechas sin compartir períodos, estados, archivos, ajustes, aprobaciones ni cierres.
- RR. HH. necesita descargar información actualizada en cuatro ventanas: diaria, semanal (lunes a domingo), quincenal (1–15 o 16–fin de mes) y mensual de remuneraciones (16–15).
- La descarga debe regenerarse desde la información vigente.
- El archivo mensual aprobado y cerrado es el resultado oficial e inmutable.
- No se autorizaron merge, push, despliegue ni cambios productivos.

## Implementado en este punto de control

- `reporting_periods` ahora tiene `company_id`; el historial se migra al UUID de Arcotex.
- El mismo ciclo 16–15 puede existir para empresas distintas, pero no puede solaparse dentro de una misma empresa.
- Las relaciones de versiones, conflictos, aprobaciones y operaciones de cierre validan conjuntamente empresa y período.
- Las políticas de acceso a períodos exigen membresía de la empresa, workspace laboral habilitado, rol de RR. HH. y MFA donde corresponde.
- Los tres caminos SQL que registran un Excel aceptado resuelven el período dentro de la empresa indicada.
- Consultas y transiciones de períodos, aprobación, cierre y descarga cerrada filtran por empresa.
- La interfaz ofrece exactamente cuatro descargas: diaria, semanal, quincenal y mensual 16–15.
- El antiguo enlace `tipo=pago` sigue funcionando como compatibilidad, pero ya no aparece como quinta opción.
- La descarga, comparación, subida, historial y nueva descarga funcionan en las cuatro ventanas controladas.
- Las versiones de trabajo diarias, semanales y quincenales quedan separadas por empresa, frecuencia y rango exacto.
- Los cambios aceptados de una ventana corta se reaplican al regenerar exactamente esa misma ventana, sin convertirla en un cierre oficial.
- El ciclo mensual 16–15 conserva su historial, aprobación exclusiva de RR. HH. y snapshot oficial inmutable.
- La base vuelve a validar la identidad del archivo, el rango permitido, la empresa, el rol, el objeto de Storage y la lista cerrada de celdas ejecutables.
- La selección de empresa laboral activa se conserva en una cookie `HttpOnly`, pero cada petición vuelve a comprobar la membresía activa, el workspace habilitado y el rol laboral; la cookie no concede acceso por sí sola.
- Una persona con varias empresas elige el tenant desde `/empresas`; una sola empresa laboral operativa conserva el acceso directo para no romper el flujo actual de Arcotex.
- Dashboard, revisión diaria, motor de reglas, horarios, períodos y los flujos de descarga/subida del Excel dejaron de depender del UUID fijo de Arcotex.
- Las consultas agregadas modificadas filtran grupos, trabajadores, períodos, corridas del motor, versiones, ajustes y objetos de Storage por la empresa activa.
- El menú laboral muestra el nombre de la empresa seleccionada y permite volver al selector.
- El gate SQL de descarga acepta ahora `DIARIO` únicamente cuando inicio y término son el mismo día; conserva sesión, membresía Arcotex, MFA, cuota y auditoría.
- Para Arcotex, descarga y reimportación quedan obligatoriamente acotadas al padrón conciliado mediante `ARCOTEX_PILOT_EMPLOYEE_IDS`: el servidor exige exactamente 60 UUID únicos y que todos pertenezcan al tenant/alcance autorizado. Si falta la configuración, la exportación se bloquea; jamás cae al padrón heredado de GESTORA. Las demás filas solo se leen para validar pertenencia y no se modifican. Un snapshot ya cerrado sin atestación de esos 60 se rechaza en vez de filtrarse o regenerarse.

## Fase 4: recorrido real del Excel completado

La validación se hizo el 2026-09-06 en una instancia Supabase local aislada, con una cuenta ficticia `ADMIN_RRHH` en AAL2, 55 trabajadores ficticios y sin conexiones a producción.

- Se descargaron desde la interfaz las cuatro ventanas: un día, una semana lunes-domingo, una quincena 1-15 y un ciclo de pago 16-15.
- Cada archivo contenía las tres hojas visibles `RESUMEN_NOMINA`, `CONTROL_PENDIENTES` y `MATRIZ_DIARIA_SABANA`, más `_GESTORA_TECNICA` en estado `veryHidden`.
- Se renderizaron e inspeccionaron visualmente las tres hojas visibles. No aparecieron errores de fórmula, cortes graves ni defectos de legibilidad.
- La comparación real detectó solamente los dos cambios ficticios esperados: `RESUMEN_NOMINA!R6` de 0 a 30 minutos y `S6` con su motivo.
- RR. HH. confirmó la versión 1. La nueva descarga conservó el ajuste, el motivo, el formato editable y la fórmula `AD6+R6/1440`, recalculada a `0:30`.
- Se creó una versión 2 desde la descarga regenerada: `R6` pasó de 30 a 45 y `S6` recibió un segundo motivo. El historial mostró v2 y v1 con su actor, fecha, motivo y cadena de versión.
- La recuperación exacta de v1 produjo SHA-256 `4cd26fbbde3c6e80f5d59d895bc1f7a6aebab1aa8860c46430b6690e318c1254`, idéntico al archivo aceptado. La de v2 produjo `1645889a4424fefd57cc923e4898547edb6b28905e9236b6a44d67cd2302e653`, también idéntico.
- La descarga posterior a v2 fijó a v2 como base vigente, conservó el ajuste de 45 minutos y recalculó el total HH50 a `0:45`.
- Una planilla manipulada que dejó visible la hoja técnica fue rechazada por la interfaz. No creó versión, cambios ni objeto en Storage.
- El límite de 20 accesos por hora respondió `429` al intento 21 sin filtrar datos. Para continuar la prueba se reinició solo la cuota del entorno ficticio.
- Durante el recorrido apareció una falla real: la interfaz ofrecía descarga diaria, pero el gate SQL la rechazaba. Se corrigió y se añadió `supabase/tests/106_daily_attendance_export_authorization.sql`.

## Evidencia ejecutada sobre el código actual

| Control | Resultado |
|---|---|
| `npx tsc --noEmit` | Aprobado |
| `npm run lint` | Aprobado |
| `npm test` | 1.374 aprobadas, 0 fallidas, 2 omitidas; 1.376 total |
| `npm run build` | Aprobado con Next.js 16.3.3 |
| `npx supabase test db` | 2.516 aprobadas en 106 archivos; 0 fallidas |
| Pruebas focalizadas de empresa activa y aislamiento | 55/55 aprobadas |
| Pruebas focalizadas de reglas y Excel | 198 aprobadas, 0 fallidas, 0 omitidas |
| Generación estructural del Excel | Cuatro frecuencias; tres hojas visibles, hoja técnica `veryHidden`, rango e identidad verificados |
| Recorrido navegador descargar → editar → comparar → aprobar → redescargar | Aprobado con dos versiones y recuperación exacta por SHA-256 |
| Seguridad de reimportación | Archivo con hoja técnica expuesta rechazado; 0 evidencia persistida por el intento |

La primera corrida completa de pgTAP se hizo después del recorrido manual y falló porque los fixtures de 55 personas y dos períodos seguían cargados. Se descartó ese resultado, se reinició exclusivamente la instancia aislada y se repitió desde migraciones limpias: 2.516/2.516 aprobadas. Luego se detuvo la instancia aislada y se restauró `supabase/config.toml`. La instancia compartida `Workera` no se reinició ni se modificó.

## Fase 5: 30 simuladores laborales completados

Los 30 escenarios se ejecutaron individualmente con datos ficticios. El ejecutor puro obtuvo inicialmente 21 aprobados, 0 fallidos, 9 parciales y 0 no ejecutados. Las nueve brechas se comprobaron después con render real del Excel, pruebas pgTAP en una Supabase aislada, dos sesiones PostgreSQL concurrentes y un ciclo real DB–Storage. Con esa evidencia complementaria el resultado validado quedó en 30 aprobados, 0 fallidos, 0 parciales y 0 no ejecutados.

- El simulador 2 se renderizó de forma individual. `RESUMEN_NOMINA!A6` mostró `BLOQUEADO` en rojo, `O6` mostró un pendiente y `CONTROL_PENDIENTES` vinculó la fecha ficticia con `HH 50% sin decisión`. No hubo errores de fórmula.
- Los simuladores 12, 19, 20, 23, 24 y 25 se cerraron combinando su ejecución concreta con las pruebas aisladas 095–105 y con el recorrido DB–Storage de la fase 4.
- El simulador 29 se repitió contra PostgreSQL real mediante dos confirmaciones simultáneas. Ambas devolvieron `245f0f70-942b-4488-9e60-ae88cc746561`; quedaron una versión y un recibo, sin duplicados.
- El simulador 30 ejecutó preparación, subida privada, commit de cierre, descarga exacta, reapertura con motivo y una versión posterior. El snapshot cerrado fue `7aaa11e3-488b-4814-a6a6-1e3918bb89e9`; el SHA-256 subido y descargado fue `c1ee533f985246a22c54a588ad65ab4c30b5b4fa7709cbc590470b3422850e34`; la reapertura conservó el cierre anterior y la nueva versión aceptada fue `7dbc1242-e903-4809-a51e-fcc692d6f3ff`.

El recorrido del simulador 30 descubrió una falla crítica real: la reserva `PREPARED` protegía la ruta antes de que Storage pudiera crear el snapshot, de modo que el protocolo documentado `prepare → upload → commit` se bloqueaba a sí mismo con `42501`. La migración `20260906233000_allow_prepared_payroll_snapshot_upload.sql` permite solamente el primer `INSERT` en la ruta reservada por el mismo actor. `commit_payroll_period_close` sigue verificando hash, tamaño, MIME y metadatos, y cualquier `UPDATE`, `DELETE`, recreación o escritura de otro actor permanece bloqueada. La prueba `107_prepared_payroll_snapshot_upload.sql` reproduce conductualmente la subida válida y los intentos prohibidos.

La validación final se repitió desde una reconstrucción limpia de la Supabase aislada: 107 archivos pgTAP y 2.524/2.524 comprobaciones aprobadas. La suite TypeScript completa obtuvo 1.374 aprobadas, 0 fallidas y 2 omitidas; las 158 pruebas focalizadas aprobaron; TypeScript, lint y el build de producción terminaron con código de salida 0.

## Pendiente para continuar

1. Hacer la auditoría final contra el prompt maestro recuperable y emitir el veredicto de marcha blanca. No declarar listo si alguna regla crítica queda sin evidencia.
2. Después del piloto Arcotex, extender el aislamiento por empresa a las tablas laborales heredadas que todavía dependen del modelo Arcotex único y completar el NO-GO multiempresa documentado en `docs/PLATFORM_MULTI_COMPANY.md`.
3. Al incorporar una segunda empresa, convertir horarios, jornada, topes, bono y excepciones en una plantilla base con ajustes por empresa. Hoy las reglas operativas siguen siendo las de Arcotex.

## Punto seguro para retomar

Antes de continuar:

```powershell
git switch codex/prenomina-marcha-blanca
git status --short --branch
git log --oneline -3
```

El siguiente bloque recomendado es la auditoría final contra el prompt maestro, usando la tabla completa de 30 simuladores ya ejecutados. La ampliación multiempresa queda deliberadamente después del piloto Arcotex.
