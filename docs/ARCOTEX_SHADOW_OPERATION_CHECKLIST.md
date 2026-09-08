# Checklist operativo condicionado — marcha blanca de asistencia ARCOTEX

## Regla de uso

Este paquete **no inicia ni autoriza** la marcha blanca. Solo puede usarse si,
para el mismo candidato hospedado, se cumplen simultáneamente estas dos
condiciones y sus evidencias están enlazadas en el acta:

- [ ] El gate hospedado de `ARCOTEX_LABOR_PILOT` emitió `GO` explícito.
- [ ] Plataforma confirmó que el SHA desplegado coincide exactamente con el
  SHA evaluado por ese gate.

Si falta una condición, el estado es `BLOQUEADO` y no se abre ninguna sesión
con datos reales. Un resultado local, un E2E sintético o un dashboard visible
no reemplazan esas evidencias.

## Alcance inmutable

Permitido: revisión humana en sombra de una sola semana lunes-domingo ya
recolectada para ARCOTEX; asistencia diaria, marcaciones faltantes, atrasos,
salidas anticipadas, ausencias, horas extra y validación visual del `.xlsx`.

Fuera de alcance durante toda la operación:

- efectos o envíos a remuneraciones, descuentos, pagos o decisiones laborales;
- aprobaciones automáticas, agentes que resuelvan casos o cambios masivos;
- sincronizar o importar una semana nueva, reescribir la fuente Workera o
  reparar datos como parte de la sesión de sombra;
- habilitar Workera, correo, WhatsApp, OCR, contabilidad u otra integración;
- otras empresas, Rendiciones, adjuntos de licencias y expansión multiempresa;
- migraciones, despliegues, cambios de flags, limpiezas, semillas o reinicios.

Una necesidad fuera de esta lista se registra como bloqueo y se deriva a una
ventana de cambio separada; no se resuelve dentro de la marcha blanca.

## Roles y segregación

Asignar personas concretas en un registro privado de acceso restringido. En
este documento y en tickets compartidos usar solo rol, fecha y decisión.

- **Dueño de decisión (Negocio ARCOTEX):** acepta o rechaza la apertura y el
  cierre; no delega su firma al operador técnico.
- **Responsable de RR. HH.:** revisa los casos y valida el libro en su Excel de
  escritorio; ninguna observación suya produce efectos de nómina.
- **Supervisor de asistencia:** contrasta excepciones con el proceso humano
  autorizado y clasifica discrepancias sin cambiar la fuente.
- **Operador de Plataforma:** confirma gate, SHA desplegado, salud y alcance;
  pausa la sesión ante un criterio técnico.
- **Security/Privacy:** confirma que la evidencia compartida está minimizada y
  atiende incidentes de acceso o exposición.
- **Secretario de acta:** conserva solo agregados, decisiones y referencias a
  evidencia protegida; nunca copia PII, credenciales, capturas o trazas.

Se requiere al menos una persona de RR. HH. y una de Plataforma presentes. La
misma persona no puede confirmar por sí sola el GO técnico y la aceptación de
Negocio.

## Fase 0 — prerequisitos de GO

- [ ] Gate hospedado `GO`, con fecha, alcance `ARCOTEX_LABOR_PILOT`, SHA y
  referencia protegida.
- [ ] SHA desplegado confirmado por una fuente independiente del navegador del
  revisor y exactamente igual al SHA del gate.
- [ ] Candidato sin cambios posteriores; si fue redesplegado, repetir el gate.
- [ ] Owner de Negocio, RR. HH., Supervisor, Plataforma y Security/Privacy
  identificados; suplencias y canal de incidente acordados.
- [ ] Ventana de operación y hora límite de decisión acordadas.
- [ ] Todos los módulos y proveedores fuera de alcance confirmados apagados.
- [ ] Acceso con cuentas personales, rol mínimo y AAL2 verificado; ninguna
  cuenta compartida ni sesión administrativa para revisión diaria.
- [ ] Observabilidad, alerta accionable y responsable de guardia confirmados.
- [ ] Criterios de pausa entendidos por todos; la pausa no requiere votación.
- [ ] Ubicación protegida para actas y evidencia acordada, con retención y
  permisos definidos.

Toda casilla depende de evidencia humana u hospedada externa a esta rama y
permanece `BLOQUEADO` hasta ser completada por su responsable.

## Fase 1 — fijar la semana ya recolectada

Plataforma ejecuta el preflight autorizado descrito en
`docs/ARCOTEX_ATTENDANCE_PILOT.md`. El secretario transcribe **solo** su salida
agregada al acta; no pega consola, consultas, identificadores ni filas.

- [ ] El resultado exacto es `READY_FOR_SHADOW_REVIEW`.
- [ ] La semana seleccionada es lunes-domingo, cerrada y fue elegida por el
  control entre las últimas ocho semanas.
- [ ] Tiene sincronización exitosa 7/7, marcaciones fuente y registros diarios
  derivados.
- [ ] La última ejecución del motor de cada día está en `SUCCEEDED`.
- [ ] El padrón autorizado reporta 45 vinculadas, cero ambiguas, cero faltantes
  y `authorizedCodesMatch: true`.
- [ ] Inicio y fin de la semana y conteos agregados quedaron congelados en el
  acta; todos los revisores usan esa misma ventana.

No se elige una fecha manualmente para conseguir un mejor resultado. Si el
preflight selecciona otra semana que la esperada, cambian conteos o requiere
reparación/reproceso, se pausa y se deriva; este checklist no autoriza aplicar
esas acciones.

## Fase 2 — recorrido diario en sombra

Repetir en orden para cada uno de los siete días, sin editar la fuente ni
aprobar efectos laborales:

1. Plataforma confirma que la sesión sigue en el SHA aprobado, ARCOTEX y la
   ventana congelada; registra salud y frescura en agregados.
2. RR. HH. abre Revisión diaria y confirma la fecha antes de observar casos.
3. RR. HH. y Supervisor revisan pendientes, marcaciones faltantes, atrasos,
   salidas anticipadas, ausencias y horas extra.
4. Cada discrepancia se clasifica en el registro protegido como `COINCIDE`,
   `REQUIERE_ACLARACION` o `DEFECTO_CANDIDATO`. En el acta quedan únicamente
   totales por categoría y tipo.
5. Un caso dudoso no se corrige ni se fuerza: queda pendiente de revisión
   humana fuera del producto y bloquea el cierre del día cuando pueda cambiar
   su interpretación.
6. Plataforma compara conteos de inicio y cierre. Una variación no explicada
   pausa la operación.
7. RR. HH., Supervisor y Plataforma firman el cierre diario o registran
   `PAUSADO`; nunca se marca completo con casos omitidos.

## Fase 3 — validación manual del XLSX

Solo después de cerrar los siete días, RR. HH. descarga el libro permitido
desde GESTORA y abre **esa copia guardada** mediante **Archivo → Abrir** en su
Excel de escritorio (Excel 2013 o posterior).

- [ ] Nombre terminado en `.xlsx` y tamaño mayor que cero.
- [ ] Excel lo abre sin reparación, bloqueo ni advertencia.
- [ ] Existen `RESUMEN_NOMINA`, `CONTROL_PENDIENTES` y
  `MATRIZ_DIARIA_SABANA`.
- [ ] Ventana y cantidad de trabajadores coinciden con el corte congelado.
- [ ] Vista de impresión horizontal, una página de ancho y sin exigir una sola
  página de alto.
- [ ] Se registraron versión de Excel, tamaño, resultado y hora, sin adjuntar
  el libro, capturas, nombres, RUT, correos ni celdas.

No renombrar a `.xls`, no reimportar el libro y no usarlo para remuneraciones.
Una advertencia, reparación o diferencia produce pausa; se registra el mensaje
sanitizado y se escala al dueño técnico.

## Pausa, reversa y reanudación

Cualquier participante puede ordenar `PAUSA` si aparece al menos uno:

- gate o SHA ausente, distinto, vencido por redespliegue o no verificable;
- acceso entre empresas, rol inesperado, AAL1 o cuenta compartida;
- día sin 7/7, motor distinto de `SUCCEEDED`, error de consulta o cambio de
  conteos no explicado;
- PII, secreto, captura, traza o dato fila-a-fila en evidencia no autorizada;
- automatización, integración o módulo fuera de alcance activo;
- discrepancia que pueda afectar una decisión laboral o de remuneraciones;
- alerta sin responsable, degradación no explicada o libro XLSX inválido.

La reversa de esta revisión consiste en detenerla, cerrar sesiones, bloquear
nuevas descargas y preservar la evidencia mínima. No borrar datos, auditoría o
archivos; no resetear staging; no cambiar flags, desplegar ni reprocesar desde
este checklist. Plataforma/Security abre el runbook de incidente aplicable.

Reanudar exige causa entendida, autorización del dueño correspondiente y gate
hospedado nuevamente válido para el SHA efectivamente desplegado. Se abre una
nueva sesión/acta; no se sobrescribe la anterior.

## Métricas sanitizadas y cierre

Registrar por día y al final, solo como números agregados:

- fecha revisada; hora de inicio/fin; estado `CERRADO` o `PAUSADO`;
- conteo inicial y final de casos por tipo;
- totales `COINCIDE`, `REQUIERE_ACLARACION` y `DEFECTO_CANDIDATO`;
- errores técnicos por categoría segura y alertas disparadas/atendidas;
- descarga XLSX intentada, aprobada o fallida, versión de Excel y tamaño;
- decisiones de pausa, responsable, referencia protegida y resolución.

No calcular tasas que puedan revelar a una persona en grupos pequeños ni
publicar texto libre originado en fichas. El cierre final requiere siete
cierres diarios, XLSX aprobado, cero incidentes abiertos y firmas de Negocio,
RR. HH., Plataforma y Security/Privacy. El resultado posible es
`MARCHA_BLANCA_EN_SOMBRA_CERRADA`, `PAUSADA` o `NO_INICIADA`; nunca “lista para
remuneraciones” ni autorización de producción.
