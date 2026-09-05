# Evidencia hospedada de MFA

Estado: **rollout MFA cerrado para el alcance actual** el 5 de septiembre de
2026. Esta evidencia no convierte por sí sola staging ni producción en GO.

Ambiente verificado: `https://arcotex-workera-staging.vercel.app`.

Se comprobó, sin registrar secretos, QR, códigos ni identificadores de factor:

- `MFA_ENFORCEMENT_ENABLED=true` en el despliegue hospedado;
- existe una sola identidad `OWNER` activa, decisión suficiente para el alcance
  actual del producto;
- el OWNER tiene dos factores TOTP verificados;
- login con Google desde un teléfono externo, desafío TOTP y llegada al control
  plane con sesión AAL2;
- una sesión privilegiada AAL1 es desviada al desafío y los RPC sensibles
  vuelven a exigir AAL2;
- la cuenta OWNER no puede reiniciarse a sí misma desde la aplicación.

La incorporación futura de un OWNER/ADMIN de plataforma o de un rol laboral
legacy privilegiado no reabre el diseño: esa identidad deberá inscribir MFA en
su primer acceso. Los roles RBAC puros se incorporarán en una fase posterior,
después de que todos sus RPC mutativos exijan AAL2 en backend.

El ensayo destructivo de recuperación no se ejecutó contra el único OWNER real.
Permanece separado en el gate `OWNER_RECOVERY_DRILL` y debe hacerse con una
cuenta de prueba según `docs/PLATFORM_OWNER_RUNBOOK.md`.
