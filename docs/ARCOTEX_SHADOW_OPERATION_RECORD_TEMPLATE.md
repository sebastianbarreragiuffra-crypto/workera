# Acta sanitizada — marcha blanca de asistencia ARCOTEX

> Plantilla vacía. No incluir credenciales, PII, IDs reales, capturas, trazas,
> filas, libros ni enlaces públicos. Las referencias deben apuntar a evidencia
> protegida con acceso mínimo.

## Control de apertura

- Estado: `NO_INICIADA | BLOQUEADO | EN_CURSO | PAUSADO | CERRADO`
- Fecha y ventana autorizada:
- Alcance del gate: `ARCOTEX_LABOR_PILOT`
- Resultado del gate hospedado: `GO | NO_GO | NO_VERIFICADO`
- SHA evaluado por el gate:
- SHA desplegado confirmado:
- ¿Coinciden exactamente?: `SI | NO | NO_VERIFICADO`
- Referencia protegida del gate:
- Referencia protegida de confirmación del despliegue:
- Decisor de Negocio (rol, no nombre):
- Responsable RR. HH. (rol, no nombre):
- Supervisor (rol, no nombre):
- Plataforma de guardia (rol, no nombre):
- Security/Privacy (rol, no nombre):
- Decisión de apertura y hora:
- Bloqueos humanos o externos pendientes:

## Semana congelada

- Inicio (lunes):
- Fin (domingo):
- Preflight: `READY_FOR_SHADOW_REVIEW | OTRO | NO_EJECUTADO`
- Días sincronizados: `/7`
- Días con última corrida `SUCCEEDED`: `/7`
- Marcaciones fuente (agregado):
- Registros diarios derivados (agregado):
- Padrón: vinculadas / ambiguas / faltantes:
- `authorizedCodesMatch`: `true | false | no_verificado`
- Referencia protegida de la salida agregada:

Si el preflight no es `READY_FOR_SHADOW_REVIEW`, registrar `BLOQUEADO` y no
completar las secciones operativas.

## Cierre diario

Duplicar este bloque siete veces, uno por fecha.

- Fecha:
- Inicio / fin:
- Estado: `CERRADO | PAUSADO | NO_REVISADO`
- Pendientes iniciales / finales:
- Marcaciones faltantes revisadas:
- Atrasos revisados:
- Salidas anticipadas revisadas:
- Ausencias revisadas:
- Horas extra revisadas:
- `COINCIDE` / `REQUIERE_ACLARACION` / `DEFECTO_CANDIDATO`:
- Errores técnicos por categoría segura:
- Alertas disparadas / atendidas:
- ¿Conteos estables o diferencia explicada?:
- Decisión y referencia protegida:
- Firmas por rol: RR. HH. / Supervisor / Plataforma:

## Validación XLSX de RR. HH.

- Fecha y hora:
- Extensión `.xlsx`: `APROBADO | FALLIDO | NO_EJECUTADO`
- Tamaño mayor que cero: `APROBADO | FALLIDO | NO_EJECUTADO`
- Excel abre sin reparación/advertencia: `APROBADO | FALLIDO | NO_EJECUTADO`
- Tres hojas esperadas: `APROBADO | FALLIDO | NO_EJECUTADO`
- Ventana y cantidad coinciden: `APROBADO | FALLIDO | NO_EJECUTADO`
- Configuración de impresión: `APROBADO | FALLIDO | NO_EJECUTADO`
- Versión de Excel:
- Tamaño del archivo (sin nombre ni ruta):
- Mensaje sanitizado si falló:
- Firma RR. HH. (rol):

## Pausas e incidentes

- Hora:
- Criterio activado:
- Ordenó la pausa (rol):
- Alcance detenido:
- Evidencia preservada (referencia protegida):
- Owner de resolución:
- Estado: `ABIERTO | RESUELTO`
- Decisión de reanudación y nuevo gate/SHA, si aplica:

## Acta final

- Días cerrados: `/7`
- Casos revisados por categoría (agregados):
- Aclaraciones abiertas:
- Defectos candidatos abiertos:
- Incidentes abiertos:
- Validación XLSX: `APROBADA | FALLIDA | NO_EJECUTADA`
- Resultado: `MARCHA_BLANCA_EN_SOMBRA_CERRADA | PAUSADA | NO_INICIADA`
- Riesgos residuales aceptados, owner y expiración:
- Firma Negocio (rol/fecha):
- Firma RR. HH. (rol/fecha):
- Firma Plataforma (rol/fecha):
- Firma Security/Privacy (rol/fecha):
- Próxima decisión autorizada:

Este acta no autoriza remuneraciones, automatización, integraciones, despliegue
ni promoción a producción.
