# Validación hospedada de acceso ARCOTEX

Arnés de caja negra para staging que usa cuatro cuentas sintéticas: RR. HH.,
supervisor de Producción, supervisor de Instalación y usuario autenticado sin
acceso. No se conecta hasta que el operador confirma explícitamente que el SHA
candidato está desplegado. No realiza mutaciones: las operaciones sensibles se
validan por disponibilidad/rechazo de sus rutas y los intentos IDOR son lecturas
con UUID sintéticos.

## Preparación

1. Obtener el SHA completo del candidato con `git rev-parse HEAD`. Obtener el
   SHA desplegado desde los metadatos del proveedor (no desde la aplicación
   bajo prueba), registrarlo en `HOSTED_DEPLOYED_SHA` y comprobar que coincide.
   `HOSTED_GATE_SHA` debe identificar el mismo commit que contiene este arnés;
   los tres SHA completos deben ser idénticos.
2. Crear las cuatro cuentas y fixtures sintéticos mediante el procedimiento
   aprobado del entorno. No usar nombres, RUT, correos ni documentos reales.
3. Copiar `.env.hosted.example` a un archivo fuera del repositorio, completar
   secretos por canal privado, completar ambos SHA completos y cambiar
   `HOSTED_EXECUTION_APPROVED` a `staging-deployed` sólo durante la ventana
   autorizada. Registrar el inicio y fin de esa ventana en UTC. El operador
   debe entrar al proveedor y al entorno con su cuenta personal AAL2 y recién
   entonces cambiar `HOSTED_OPERATOR_AAL2_APPROVED` a `personal-aal2`. El
   preflight falla cerrado si los SHA no son idénticos o si la hora actual
   queda fuera de la ventana.
   Registrar además las huellas SHA-256 de la autorización sanitizada y de la
   evidencia sanitizada del proveedor. Sólo las huellas entran al resultado;
   los documentos originales permanecen en el sistema privado autorizado.
4. Cada `ALLOWED_EMPLOYEE_ID` debe pertenecer al área/empresa/padrón del rol.
   Los tres canarios deben estar presentes únicamente en los registros que el
   rol probado no puede leer. `HOSTED_OUTSIDE_ROSTER_EMPLOYEE_ID` debe existir
   como fixture sintético fuera del padrón ARCOTEX autorizado.

El preflight también exige las cuatro credenciales, cuatro secretos TOTP
Base32, los siete UUID con formato válido y tres canarios distintos antes de
iniciar el navegador. Cada sesión debe completar el desafío y luego acredita
AAL2 contra la ruta hospedada que lee claims verificados en servidor.

Ejecutar desde la raíz, sin imprimir el archivo de entorno:

```powershell
node --env-file="C:\ruta-privada\arcotex-hosted.env" .\node_modules\@playwright\test\cli.js test --config=tests/hosted-access/playwright.config.ts
```

No usar `set`, `Get-Content`, `--debug` ni reporteros HTML durante la ventana.
El archivo privado debe estar fuera del repositorio y su ruta no se registra en
el acta. Si el proveedor no entrega un SHA completo confirmado, el resultado es
`NO EJECUTADO`, nunca una aprobación condicional.

El reporter hospedado es deliberadamente sanitizado: no imprime errores,
cuerpos, URLs, adjuntos ni trazas. Ante un fallo se conserva sólo el nombre
estático y estado del caso; el diagnóstico detallado requiere una nueva ventana
controlada, no activar artefactos invasivos sobre el ambiente compartido.

## Criterio de aprobación

Los diez casos deben pasar, sin omitidos: RR. HH. navega por las tres áreas y por rutas
privilegiadas; cada supervisor sólo entra a su área y no a rutas privilegiadas;
el usuario sin acceso nunca obtiene el shell; los UUID de otra área, empresa o
fuera del padrón producen una respuesta segura; ningún canario prohibido aparece.
Un timeout, 5xx, redirección inesperada, fuga de canario o configuración ausente
es fallo, no evidencia inconclusa aprobatoria.

El único artefacto persistente es
`test-results/hosted-access-sanitized/results.jsonl`. Su primer registro vincula
la corrida con ambos SHA, los límites UTC de la ventana, las huellas SHA-256 de
autorización/evidencia y la validación booleana de las aprobaciones; los
restantes guardan nombre y estado del caso. El arnés deshabilita capturas,
video y trazas, y nunca guarda cuerpo, correo, UUID, cookie ni token.

## Limpieza segura

Cerrar las sesiones del navegador al terminar, revocar las sesiones de las
cuatro cuentas desde Auth y volver a dejar ambas aprobaciones en `blocked` en el
archivo privado. Retirar los fixtures sintéticos con el procedimiento aprobado
del entorno, verificando primero sus UUID exactos y sin borrados masivos. Eliminar
el archivo privado y `test-results/hosted-access-sanitized` sólo después de
conservar el resumen sanitizado requerido. Este arnés no crea datos ni necesita
rollback propio.

Usar `REPORT_TEMPLATE.md` para el acta. No copiar salida de consola completa:
sólo totales, estado por caso, SHA y observaciones sin identificadores.
