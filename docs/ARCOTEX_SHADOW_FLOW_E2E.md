# E2E determinista del flujo diario ARCOTEX

## Propósito y alcance

Este arnés cubre la navegación diaria de la marcha blanca ARCOTEX sin usar
credenciales, datos personales, Supabase local ni staging. Ejecuta las páginas,
layouts, componentes y view-models reales de la aplicación, pero reemplaza en
tiempo de compilación las fronteras de Supabase, middleware de sesión y estado
de sincronización con fixtures sintéticos deterministas.

No demuestra que staging, Auth/RLS, Workera ni sus datos estén listos. Tampoco
cambia el veredicto y los criterios de entrada de
`docs/ARCOTEX_ATTENDANCE_PILOT.md`.

## Ejecución

```powershell
npm run test:e2e:arcotex
```

En Windows se usa el canal estable de Chrome instalado en el equipo. En otros
entornos se usa el navegador configurado por Playwright; se puede fijar un
canal con `PLAYWRIGHT_CHANNEL`.

El comando levanta un servidor Next de desarrollo aislado en el puerto 3107
(`ARCOTEX_SHADOW_E2E_PORT` permite cambiarlo), usa el directorio temporal
`.next-arcotex-shadow-e2e` y lo elimina al terminar.

## Cobertura automatizada

- una entrada controlada que representa una sesión ARCOTEX ya autenticada;
- rechazo con 404 de una petición que no trae la clave efímera del arnés;
- dashboard y selectores Hoy, Ayer y fecha elegida;
- Revisión diaria con cambio de fecha y área;
- casos pendientes y empleados sin novedades;
- vistas de solo lectura de Licencias y Horarios;
- estado de carga anunciado a tecnologías de asistencia;
- error seguro y reintento funcional;
- navegación básica por teclado;
- ausencia de `console.error` y errores no capturados del navegador.

Todos los nombres, identificadores y estados del fixture son sintéticos. El
fixture no contiene correos, RUT, documentos, credenciales ni nombres de
personas reales.

## Controles de seguridad del arnés

El reemplazo solo se activa cuando `ARCOTEX_SHADOW_E2E=enabled` y
`NODE_ENV=development`. Intentar habilitarlo en producción hace fallar la
configuración. La clave de entrada se genera en cada ejecución, se mantiene en
memoria y debe coincidir tanto en el proxy como en la frontera Supabase. El
comportamiento normal de la aplicación queda intacto cuando el flag no existe.

## Límites y pruebas que deben vivir en otros alcances

Este arnés no cubre:

- una sesión real de Supabase Auth, AAL2, RLS o membresía de tenant;
- disponibilidad, red, datos o secretos del staging hospedado;
- frescura real de Workera, sync, reprocessing o el motor de asistencia;
- mutaciones, aprobaciones, adjuntos o descargas de licencias;
- carga o generación de Excel: la consulta de versiones que el dashboard hace
  en segundo plano se responde dentro del test para no entrar en ese dominio;
- Gestora/control plane, otras empresas, Rendiciones ni otros productos;
- DAST, pentest, carga, soak, restore drill, paging o aceptación formal.

Un smoke posterior contra staging necesita un usuario sintético aprobado,
secretos inyectados por el entorno (nunca versionados ni impresos) y una
ventana autorizada. Debe verificar al menos login/AAL2, aislamiento ARCOTEX,
RLS, datos sintéticos esperados y logout, sin tocar datos reales ni ejecutar
acciones laborales. Esa evidencia pertenece al trabajo de Auth/plataforma y al
canario de integración; no debe simularse ni declararse cumplida desde esta
rama.

## Correcciones pequeñas incorporadas

- El `loading` de Revisión diaria ahora anuncia su estado y mantiene el
  esqueleto fuera del árbol accesible.
- El enlace de reintento deshabilita el prefetch de Next para evitar precargar
  y reutilizar la misma respuesta fallida antes del clic.
