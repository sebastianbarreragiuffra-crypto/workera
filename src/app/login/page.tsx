"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

/**
 * UI mínima funcional. Sin diseño final ni dashboard — esta fase es
 * seguridad/auth (encargo Fase 3 sección 48), no UX.
 */
export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <main style={{ maxWidth: 320, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Workera — Acceso corporativo</h1>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          Email
          <input type="email" name="email" required autoComplete="username" style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            style={{ display: "block", width: "100%" }}
          />
        </label>
        {state.error ? <p role="alert" style={{ color: "crimson" }}>{state.error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Ingresando..." : "Iniciar sesión"}
        </button>
      </form>
      <p style={{ fontSize: "0.85rem", color: "#555" }}>
        Acceso exclusivo para cuentas corporativas de Arcotex. No hay registro público.
      </p>
    </main>
  );
}
