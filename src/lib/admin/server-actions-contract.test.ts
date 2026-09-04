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
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      if (!exported || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;

      const asyncFunction =
        ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.AsyncKeyword);
      const asyncVariables =
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.every((declaration) => {
          const initializer = declaration.initializer;
          return (
            !!initializer &&
            (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
            hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)
          );
        });

      if (!asyncFunction && !asyncVariables) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        violations.push(`${file}:${line + 1}: ${statement.getText(sourceFile).split(/\r?\n/, 1)[0]}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Exports incompatibles con Next.js 16.3:\n${violations.join("\n")}`);
});
