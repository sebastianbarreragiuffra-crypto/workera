import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isAsyncFunctionExpression(node: ts.Expression | undefined): boolean {
  return (
    !!node &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    hasModifier(node, ts.SyntaxKind.AsyncKeyword)
  );
}

function isRuntimeExportViolation(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;

  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false;
    if (
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((specifier) => specifier.isTypeOnly)
    ) {
      return false;
    }
    return true;
  }

  if (ts.isExportAssignment(statement)) {
    return !isAsyncFunctionExpression(statement.expression);
  }

  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return false;

  if (ts.isFunctionDeclaration(statement)) {
    return !hasModifier(statement, ts.SyntaxKind.AsyncKeyword);
  }

  if (ts.isVariableStatement(statement)) {
    return !statement.declarationList.declarations.every((declaration) =>
      isAsyncFunctionExpression(declaration.initializer)
    );
  }

  return true;
}

function parseStatement(source: string): ts.Statement {
  const sourceFile = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements.at(-1);
  assert.ok(statement);
  return statement;
}

test("el clasificador AST cubre reexports y exports default", () => {
  assert.equal(isRuntimeExportViolation(parseStatement('export { value } from "./other";')), true);
  assert.equal(isRuntimeExportViolation(parseStatement('export * from "./other";')), true);
  assert.equal(isRuntimeExportViolation(parseStatement("export default value;")), true);
  assert.equal(isRuntimeExportViolation(parseStatement("export default async () => true;")), false);
  assert.equal(isRuntimeExportViolation(parseStatement('export type { Value } from "./other";')), false);
  assert.equal(isRuntimeExportViolation(parseStatement('export { type Value } from "./other";')), false);
});

test('los módulos con "use server" solo exportan funciones async en runtime', () => {
  const sourceRoot = join(import.meta.dirname, "..", "..");
  const violations: string[] = [];

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const directives = sourceFile.statements.filter(
      (statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
    );
    if (!directives.some((statement) => (statement as ts.ExpressionStatement).expression.getText(sourceFile).replace(/["']/g, "") === "use server")) {
      continue;
    }

    for (const statement of sourceFile.statements) {
      if (isRuntimeExportViolation(statement)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        violations.push(`${file}:${line + 1}: ${statement.getText(sourceFile).split(/\r?\n/, 1)[0]}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Exports incompatibles con Next.js 16.3:\n${violations.join("\n")}`);
});
