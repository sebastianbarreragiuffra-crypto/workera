# Tarjeta de decisión GO/NO-GO — marcha blanca ARCOTEX

## Uso y autoridad

Esta tarjeta convierte evidencia ya producida en una decisión operativa. No
ejecuta pruebas, no despliega y no autoriza por sí sola acceso a staging.

Solo se puede declarar `GO_SHADOW_ARCOTEX` cuando las cuatro firmas requeridas
confirman el mismo candidato, despliegue, alcance y ventana. Cualquier campo
vacío, resultado no verificable o firma ausente produce `NO_GO`.

Firmas requeridas por rol:

- Plataforma: identidad del candidato, despliegue, salud y reversa;
- Security/Privacy: acceso, AAL2, aislamiento y evidencia sanitizada;
- RR. HH.: alcance humano, semana y validación posterior del XLSX;
- Negocio ARCOTEX: aceptación del alcance y de los riesgos residuales.

Ninguna persona puede reemplazar dos firmas. Un resultado automático no firma
por un responsable humano.

## Identidad única de la decisión

Completar en un repositorio de evidencia protegido, no en Git ni chat:

```text
DECISION_ID=<referencia interna no sensible>
ALCANCE=ARCOTEX_LABOR_PILOT_SHADOW_ONLY
CANDIDATE_BRANCH=<rama publicada>
CANDIDATE_SHA=<40 caracteres>
DEPLOYED_SHA=<40 caracteres obtenidos del proveedor>
GATE_SHA=<40 caracteres sobre el que se ejecutó el gate>
WINDOW_START=<fecha y hora con zona>
WINDOW_END=<fecha y hora con zona>
AUTHORIZED_WEEK_START=<lunes seleccionado por preflight>
AUTHORIZED_WEEK_END=<domingo seleccionado por preflight>
```

Los tres SHA deben ser idénticos. No aceptar abreviaciones, valores copiados de
variables ingresadas manualmente o una rama como sustituto del SHA.

## Sobre de evidencia mínimo

Cada evidencia lleva estado `APROBADO`, `FALLIDO` o `NO_VERIFICADO`, responsable,
hora y referencia protegida. No adjuntar credenciales, PII, IDs, capturas,
trazas, cuerpos HTTP, HTML, filas ni libros.

### A. Candidato

- [ ] Rama candidata publicada y upstream limpio.
- [ ] SHA remoto completo registrado.
- [ ] TypeScript, lint, tests de aplicación y build aprobados sobre ese SHA.
- [ ] pgTAP y lint DB aprobados en una pila local aislada sobre ese SHA.
- [ ] No existen gates omitidos descritos como aprobados.

### B. Despliegue

- [ ] Ventana autorizada y operador personal con AAL2.
- [ ] SHA obtenido desde metadatos independientes del proveedor.
- [ ] `DEPLOYED_SHA = CANDIDATE_SHA`.
- [ ] No ocurrió un redespliegue después de obtener el SHA.
- [ ] Flags y módulos fuera de alcance permanecen deshabilitados, incluido
  `WORKERA_SYNC_ENABLED=false`.

### C. Gate hospedado

- [ ] La ejecución estuvo ligada al SHA, ventana y autorización anteriores.
- [ ] Las cuatro sesiones sintéticas acreditaron AAL2 ante el servidor.
- [ ] Los 10 casos multirol/IDOR terminaron aprobados.
- [ ] No hubo acceso entre empresas, áreas prohibidas o fuera del padrón.
- [ ] La salida sanitizada no contiene URLs, cuerpos, IDs ni datos personales.
- [ ] `ARCOTEX_LABOR_PILOT` emitió `GO` para el mismo SHA.

### D. Preflight de asistencia

- [ ] Resultado exacto `READY_FOR_SHADOW_REVIEW`.
- [ ] Semana cerrada seleccionada automáticamente, con sincronización 7/7.
- [ ] Última corrida del motor `SUCCEEDED` en 7/7 días.
- [ ] Existen marcaciones fuente y registros derivados, solo en agregados.
- [ ] Padrón: 45 vinculadas, cero ambiguas y cero faltantes.
- [ ] `authorizedCodesMatch: true`.
- [ ] No fue necesario importar, sincronizar, reparar o reprocesar dentro de la
  ventana de decisión.

### E. Operación humana

- [ ] Negocio, RR. HH., Supervisor, Plataforma, Security/Privacy y secretario
  tienen titular, suplente y canal acordado.
- [ ] Se aprobó el ensayo en seco y todas las brechas tienen cierre verificable.
- [ ] Todos pueden explicar quién pausa, dónde queda la evidencia y por qué la
  marcha blanca no autoriza remuneraciones.
- [ ] El procedimiento XLSX será manual en Excel de escritorio y ocurrirá solo
  después de cerrar los siete días.
- [ ] On-call y canal de incidente estarán disponibles durante toda la ventana.

## Reunión de decisión — máximo 15 minutos

1. Plataforma lee los tres SHA completos y demuestra su origen sin compartir
   secretos ni pantalla con datos.
2. Security/Privacy confirma gate, AAL2, aislamiento y sanitización.
3. RR. HH. confirma semana, alcance de solo lectura y responsables diarios.
4. Negocio confirma que no habrá remuneraciones, automatización ni integración.
5. Cada firmante responde `GO` o `NO_GO`; no se permiten respuestas condicionales.
6. El secretario registra el resultado y cierra el acta. Una abstención equivale
   a `NO_GO`.

## Mensaje canónico de salida

### Si todos los controles están aprobados

```text
GO_SHADOW_ARCOTEX
Alcance: revisión humana en sombra, solo Asistencia ARCOTEX.
Candidato, gate y despliegue: SHA completo coincidente y verificado.
Semana: ventana cerrada seleccionada por READY_FOR_SHADOW_REVIEW.
Padrón: 45; Workera sync: deshabilitado.
Efectos: sin remuneraciones, automatización, integraciones ni otras empresas.
Vigencia: únicamente la ventana autorizada.
Pausa: cualquier participante puede ordenarla.
```

Este mensaje puede enviarse al operador solo después de guardar las cuatro
firmas. El operador vuelve a comprobar SHA y vigencia antes de abrir la sesión.

### Si falta o falla un control

```text
NO_GO_SHADOW_ARCOTEX
Control bloqueante: <categoría y nombre, sin detalle sensible>.
Responsable: <rol>.
Reevaluación: <fecha/condición>.
Acción operativa: no iniciar; conservar evidencia; no cambiar staging.
```

No usar expresiones como “GO parcial”, “GO técnico” o “continuar bajo riesgo”.

## Caducidad automática

La decisión vuelve inmediatamente a `NO_GO` si:

- cambia cualquiera de los tres SHA o ocurre un redespliegue;
- termina la ventana autorizada;
- cambia la semana, padrón o conteo sin explicación aprobada;
- una sesión pierde AAL2 o aparece un rol/acceso inesperado;
- un día deja de estar sincronizado o `SUCCEEDED`;
- se habilita sincronización, remuneraciones, automatización o una integración;
- aparece PII en evidencia o una alerta queda sin responsable;
- cualquier participante ordena pausa.

Reanudar requiere una nueva `DECISION_ID`, evidencia vigente y cuatro firmas.
Nunca se modifica retroactivamente una decisión anterior.

## Traspaso al operador

El secretario entrega únicamente:

- mensaje canónico de GO o NO-GO;
- referencia protegida de la decisión;
- SHA completo y ventana autorizada;
- roles de contacto y canal de pausa/incidente;
- checklist y plantilla de acta aplicables.

El operador no recibe secretos por este traspaso y no puede ampliar el alcance.
Si no puede verificar cualquiera de esos cinco elementos, responde
`NO_GO_SHADOW_ARCOTEX` y no inicia.
