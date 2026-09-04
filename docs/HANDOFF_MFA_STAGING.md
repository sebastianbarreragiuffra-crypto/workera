# Handoff MFA staging — 4 de septiembre de 2026

## Rama para continuar

- Rama: `codex/mfa-staging-cut1`
- Último commit funcional antes de este documento: `d833ef2`
- No está fusionada a `master`.

En PC1:

```bash
git fetch origin
git switch codex/mfa-staging-cut1
git pull --ff-only
```

Si la rama todavía no existe localmente en PC1:

```bash
git fetch origin
git switch --track origin/codex/mfa-staging-cut1
```

## Estado de staging

Se respaldó primero la estructura y se aplicó únicamente el primer corte MFA:

- `20260903100000_medical_license_range_bound.sql`
- `20260903140000_mfa_totp_foundation.sql`
- `20260904150000_null_authorization_guard_fixes.sql`
- `20260904160000_mfa_security_hardening.sql`

No se aplicó `20260904120000_mfa_aal2_for_privileged_rpcs.sql` y
`MFA_ENFORCEMENT_ENABLED` continúa apagado. Por lo tanto, una cuenta sin factor
verificado no es redirigida automáticamente a la inscripción.

## Vista previa actual

`https://arcotex-workera-staging-265ne71ia.vercel.app`

La URL estable `https://arcotex-workera-staging.vercel.app` sigue apuntando a
una versión antigua y no debe usarse para validar este corte.

## Incidente pendiente: inscripción TOTP

El primer QR se rompía porque `@supabase/auth-js` ya devuelve
`data.totp.qr_code` como un data URI completo y la aplicación lo envolvía y
codificaba por segunda vez. `d833ef2` usa el valor directamente y agrega una
prueba de regresión.

El usuario informó que aún tenía problemas después del despliegue, pero no se
alcanzó a capturar una nueva evidencia del fallo. La cuenta quedó con una
inscripción TOTP no verificada. Además, el secreto de ese intento apareció en
una captura: debe considerarse expuesto y no debe confirmarse ni reutilizarse.

Primer paso al retomar:

1. Iniciar sesión en la vista previa actual.
2. Abrir `/seguridad/mfa`.
3. Descartar la inscripción no verificada existente.
4. Generar una inscripción nueva.
5. Confirmar visualmente que el QR carga y que la imagen tiene dimensiones
   naturales mayores que cero, sin registrar, capturar ni imprimir el `src`.
6. Escanear y verificar el nuevo código; cerrar sesión e iniciar otra vez para
   comprobar el desafío `/login/mfa`.

Si el QR sigue roto, comprobar en DevTools sin exponer el contenido que el
`src` tenga un solo prefijo `data:image/svg+xml;utf-8,` y que su payload no
empiece por otro `data:image` codificado.

## Validaciones ejecutadas sobre `d833ef2`

- Suite de aplicación: 827 pruebas; 825 aprobadas, 2 opcionales omitidas, 0
  fallos.
- TypeScript: aprobado.
- ESLint: aprobado.
- Build local de producción con Webpack: aprobado. Turbopack local no se usa en
  este worktree porque `node_modules` es un enlace fuera de su raíz.
- Build de Vercel con Turbopack: aprobado.
- Login real, acceso a `/seguridad/mfa` y detección de la inscripción no
  verificada: aprobados.

No activar la obligatoriedad ni aplicar la migración AAL2 hasta verificar de
punta a punta un factor nuevo y confirmar el procedimiento de recuperación.
