# GESTORA PWA segura (Fase 5)

GESTORA se puede agregar a la pantalla de inicio desde Safari o Chrome. Sigue siendo el mismo sitio web: no existe una aplicación nativa ni una segunda base de código.

## Qué funciona

- Manifest e íconos para instalación `standalone`.
- Instrucción específica para Safari iOS (`Compartir` → `Agregar a pantalla de inicio`).
- Aviso de pérdida de conexión y pantalla offline pública, genérica y sin datos.
- Actualización automática del service worker sin depender del cache HTTP.

## Límite de seguridad offline

El service worker usa una allowlist cerrada. Solo puede guardar:

- archivos versionados de `/_next/static/`;
- manifest e íconos públicos;
- la pantalla `/offline`.

Nunca guarda HTML autenticado, respuestas API, tokens, Auth, Supabase, imágenes optimizadas, comprobantes, OCR, documentos, licencias, nómina, cartolas ni CSV. Tampoco implementa IndexedDB, Background Sync ni una cola local de formularios. Si no hay conexión, el usuario debe recuperarla antes de enviar información.

## Operación

Cada cambio de política de cache debe:

1. cambiar `CACHE_VERSION` en `public/sw.js`;
2. conservar la allowlist y el fallback network-only para navegación;
3. ejecutar `src/lib/pwa/service-worker-policy.test.ts`;
4. validar en Safari iOS y Chrome Android sobre HTTPS antes de producción.
