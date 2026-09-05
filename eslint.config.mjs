import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Nested Git worktrees contain another complete checkout (and its build
    // output); linting them would duplicate the project and report generated JS.
    ".worktrees/**",
    // Ephemeral runtime artifacts written by `supabase start`/`supabase test db`
    // (vendored, minified, gitignored) — not our code.
    "supabase/.temp/**",
    "supabase/.branches/**",
    // Git worktrees checked out under el repo: son copias completas de la
    // app (incluido su build) y duplicarían cada hallazgo del código real.
    ".worktrees/**",
    // Copias/artefactos locales heredados de sesiones anteriores en PC1.
    // No forman parte de este checkout y pueden contener su propio `.next`.
    "workera/**",
    "output/**",
    "tmp/**",
  ]),
]);

export default eslintConfig;
