import path from "node:path";

const ALLOWED_ENVIRONMENT_FILES = new Set([".env.local", ".env.staging"]);

/**
 * Evita que las herramientas locales escriban UUID del padrón en archivos
 * versionados, ejemplos de entorno o rutas fuera del repositorio.
 */
export function resolveSafeArcotexEnvironmentPath(
  inputPath: string,
  repositoryRoot: string,
): string {
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(inputPath);
  if (
    path.dirname(resolved) !== root
    || !ALLOWED_ENVIRONMENT_FILES.has(path.basename(resolved))
  ) {
    throw new Error(
      "El padrón sólo puede escribirse en .env.local o .env.staging en la raíz del repositorio.",
    );
  }
  return resolved;
}
