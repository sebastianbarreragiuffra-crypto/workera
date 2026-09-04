# Conciliación bancaria de Rendiciones

## Alcance

La conciliación asistida permite que Finanzas importe una cartola CSV y confirme qué pago corresponde a qué rendición aprobada. El sistema propone coincidencias, pero nunca cambia una rendición a pagada sin una confirmación humana.

## Formato de importación

El archivo debe estar codificado como CSV UTF-8, pesar hasta 2 MB y contener como máximo 2.000 movimientos. Se aceptan coma, punto y coma o tabulación como separador.

Columnas obligatorias:

- `fecha`: `AAAA-MM-DD` o `DD/MM/AAAA`.
- `monto`: se aceptan formatos `45990`, `45.990`, `45.990,50` y `45,990.50`. Un signo negativo se normaliza a su valor absoluto porque la cartola puede representar pagos como débitos.
- `moneda`: código de tres letras, por ejemplo `CLP`, `USD` o `EUR`.
- `referencia`: identificador bancario de hasta 120 caracteres.

Columna opcional:

- `descripcion`: glosa de hasta 240 caracteres.

Ejemplo:

```csv
fecha;monto;moneda;referencia;descripcion
02/09/2026;-45990;CLP;TRX-00921;Reembolso visita a terreno
```

Las columnas adicionales se ignoran. El archivo original, los números de cuenta, el saldo y el resto del payload bancario no se guardan.

## Flujo y controles

1. Un Route Handler privado valida sesión, empresa y origen, reserva cuota durable y recién entonces lee el CSV como stream. Corta durante la recepción al superar 2 MB, tras 5 segundos sin bytes o 30 segundos totales; no usa `formData()` ni materializa primero un multipart grande. La ruta declara además un máximo de ejecución de 60 segundos.
   La ruta está excluida explícitamente del proxy global para que ninguna capa previa clone o materialice el cuerpo; conserva sus propias guardas de autenticación, empresa, rol y mismo origen.
2. El servidor valida codificación, encabezados y cada fila antes de escribir. El RPC con JSON no está disponible para el navegador: solo el límite backend `service_role` puede invocarlo y debe entregar el actor autenticado.
3. PostgreSQL normaliza las filas y calcula su propio SHA-256: el mismo contenido devuelve la importación existente aunque cambien nombre, saltos de línea u orden de filas.
4. PostgreSQL inserta todas las filas en una sola transacción; una fila inválida revierte el lote completo.
5. La bandeja sugiere hasta diez rendiciones `APPROVED` con monto y moneda exactos y hasta 45 días de diferencia.
6. Finanzas confirma una sugerencia o aparta el movimiento indicando un motivo.
7. La confirmación bloquea movimiento y rendición, registra `PAID` y genera auditoría en una única transacción.

## Seguridad y privacidad

- RLS y los RPC comprueban módulo activo, membresía y permiso `expenses.reconcile`/`expenses.manage` por empresa.
- Las tablas no permiten escritura directa a usuarios autenticados; toda mutación pasa por RPC controlados.
- El RPC de importación tampoco concede `EXECUTE` a `authenticated`; PostgreSQL vuelve a validar la identidad explícita del actor y sus permisos aunque la llamada provenga del backend privilegiado.
- Una cuota de ingreso se descuenta antes de leer el primer byte: hasta 20 intentos/40 MB reservados por usuario y 100 intentos/200 MB por empresa y hora. Después, otra cuota limita el JSON realmente procesado a 20 intentos/10 MB por usuario y 100 intentos/50 MB por empresa. Rechazos y duplicados también consumen cuota.
- Las referencias y glosas rechazan caracteres de control y controles bidireccionales Unicode que podrían ocultar o falsear visualmente una referencia bancaria.
- Claves foráneas compuestas impiden enlazar un movimiento con una rendición de otra empresa.
- Un índice único y bloqueos de fila evitan conciliar dos pagos contra la misma rendición bajo concurrencia.
- La interfaz vuelve a comprobar que el movimiento pertenece a la empresa visible antes de ejecutar la acción.

## Operación inicial

Este bloque funciona sin una API bancaria: Finanzas exporta un CSV desde su banco y lo sube a GESTORA. Una integración Open Banking futura debe alimentar el mismo contrato y conservar los mismos controles; no debe saltarse la bandeja ni la confirmación humana.
