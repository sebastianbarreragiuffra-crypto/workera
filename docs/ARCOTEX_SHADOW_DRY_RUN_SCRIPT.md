# Ensayo en seco previo — marcha blanca de asistencia ARCOTEX

## Propósito

Este ejercicio verifica coordinación, segregación de funciones y capacidad de
pausa antes de solicitar el GO operativo. Usa únicamente nombres de rol,
fechas ficticias y conteos inventados para el ejercicio. No accede a staging,
no abre fichas, no descarga libros y no demuestra que el candidato esté listo.

Resultado posible: `ENSAYO_APROBADO`, `ENSAYO_FALLIDO` o `NO_EJECUTADO`.
Aunque sea aprobado, la marcha blanca continúa en `NO-GO` hasta cumplir el
checklist hospedado y confirmar el SHA desplegado.

## Participantes mínimos

- facilitador de Plataforma;
- decisor de Negocio ARCOTEX;
- responsable de RR. HH.;
- Supervisor de asistencia;
- Security/Privacy;
- secretario de acta.

Cada participante debe tener un suplente definido. Plataforma no puede firmar
por Negocio y RR. HH. no puede validar su propio control técnico.

## Material permitido

- `docs/ARCOTEX_SHADOW_OPERATION_CHECKLIST.md`;
- una copia vacía de `docs/ARCOTEX_SHADOW_OPERATION_RECORD_TEMPLATE.md`;
- esta guía;
- tarjetas ficticias incluidas abajo;
- canal de coordinación sin datos personales.

No usar credenciales, `.env`, capturas, trazas, URLs privadas, IDs, nombres,
RUT, correos, filas, archivos reales ni resultados históricos como fixtures.

## Preparación — 10 minutos

El facilitador lee en voz alta y todos confirman:

- [ ] El ejercicio no es staging ni producción.
- [ ] `WORKERA_SYNC_ENABLED` se considera `false`; nadie cambia flags.
- [ ] El alcance es solo Asistencia ARCOTEX y un padrón esperado de 45.
- [ ] No existen efectos de remuneraciones ni decisiones automáticas.
- [ ] Cualquier persona puede ordenar `PAUSA`.
- [ ] La evidencia del ensayo será únicamente estado, rol y conteo ficticio.

Asignar por escrito los seis roles y un reloj común. Si falta un rol, registrar
`NO_EJECUTADO` y finalizar.

## Simulación de apertura — 10 minutos

El facilitador entrega esta tarjeta ficticia:

```text
Gate hospedado: GO
SHA evaluado: CANDIDATO_FICTICIO_A
SHA desplegado: CANDIDATO_FICTICIO_A
Preflight: READY_FOR_SHADOW_REVIEW
Semana: lunes ficticio a domingo ficticio
Sync: 7/7
Motor: 7/7 SUCCEEDED
Padrón: 45 vinculadas, 0 ambiguas, 0 faltantes
authorizedCodesMatch: true
```

Sin consultar sistemas, el equipo debe:

1. asignar quién valida cada dato y cuál sería su fuente independiente;
2. identificar qué evidencia debe residir en ubicación protegida;
3. completar solo los campos estructurales de una copia vacía del acta;
4. declarar si existe segregación suficiente para abrir.

Falla si un participante acepta un valor verbal sin dueño/fuente o propone
copiar consola, capturas, secretos, identificadores o filas al acta.

## Simulación diaria — 10 minutos

Usar exclusivamente estos conteos ficticios:

```text
Pendientes iniciales: 12
Coinciden: 8
Requieren aclaración: 3
Defecto candidato: 1
Pendientes finales: 4
```

RR. HH. y Supervisor describen el recorrido humano; Plataforma verifica fecha,
tenant, ventana y estabilidad de conteos; el secretario registra agregados. El
equipo debe rechazar estas propuestas deliberadamente incorrectas:

- corregir el caso dudoso durante la sesión;
- sincronizar de nuevo para reducir pendientes;
- aprobar horas extra para “probar el flujo”;
- enviar el resultado a remuneraciones;
- pegar el detalle del caso en un chat compartido.

Falla si alguna propuesta se ejecutaría o quedaría abierta a interpretación.

## Simulación de pausa — 10 minutos

Ejecutar las tres tarjetas, una por vez. La respuesta correcta comienza con
`PAUSA`, identifica un dueño y preserva evidencia mínima sin alterar datos.

### Tarjeta A — SHA divergente

El SHA del proveedor cambia de `CANDIDATO_FICTICIO_A` a
`CANDIDATO_FICTICIO_B` después de la apertura.

Esperado: cerrar la sesión; invalidar el gate anterior; exigir despliegue
explicado y nuevo gate para el SHA efectivo.

### Tarjeta B — posible exposición

Un reporte compartido contiene texto libre que podría identificar a una
persona.

Esperado: detener difusión; involucrar Security/Privacy; preservar la
referencia en canal protegido; no copiar ni repetir el contenido.

### Tarjeta C — XLSX con advertencia

Excel indica que debe reparar el libro al abrirlo.

Esperado: no renombrar, convertir, reimportar ni usar el libro; registrar solo
versión de Excel, tamaño y mensaje sanitizado; escalar al dueño técnico.

Falla si la pausa requiere unanimidad, si se continúa “solo para terminar” o
si se propone borrar evidencia.

## Simulación de cierre — 5 minutos

El secretario presenta únicamente:

- resultado y duración del ensayo;
- roles presentes/ausentes;
- tarjetas ejecutadas y respuesta `APROBADA` o `FALLIDA`;
- brechas de coordinación con owner y fecha objetivo;
- confirmación de que no se usaron sistemas ni datos reales.

Todos responden individualmente:

1. ¿Quién puede pausar?
2. ¿Qué dos evidencias vinculan el gate al despliegue?
3. ¿Qué resultado autoriza remuneraciones?
4. ¿Dónde se guarda la evidencia detallada?

Respuestas esperadas: cualquiera puede pausar; SHA evaluado y SHA desplegado
independientemente confirmado; ningún resultado de esta marcha blanca autoriza
remuneraciones; la evidencia queda en la ubicación protegida acordada.

## Criterio de aprobación

Marcar `ENSAYO_APROBADO` solo si:

- participaron todos los roles;
- se identificó fuente y dueño para cada gate;
- las tres pausas ocurrieron de inmediato y sin efectos;
- nadie propuso usar PII o cambiar sistemas;
- todas las respuestas finales fueron correctas;
- cada brecha tiene owner y fecha objetivo.

Una falla produce `ENSAYO_FALLIDO` y un nuevo ensayo completo después de la
corrección. No se editan respuestas antiguas ni se transforma el ensayo en
evidencia hospedada.
