import ts from "typescript";

function literal(node: ts.Expression): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => {
    if (!ts.isExpression(item)) throw new Error("Generated source contains a nonliteral array item");
    return literal(item);
  });
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error("Generated source contains a nonliteral property");
      const name = property.name;
      if (!ts.isStringLiteral(name) && !ts.isIdentifier(name) && !ts.isNumericLiteral(name)) {
        throw new Error("Generated source contains a computed property");
      }
      result[name.text] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("Generated source contains an executable expression");
}

export function readGeneratedExport(sourceText: string, exportName: string): Record<string, unknown> {
  const source = ts.createSourceFile("generated.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.flatMap(statement =>
    ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations] : []);
  const declaration = declarations.find(item => ts.isIdentifier(item.name) && item.name.text === exportName);
  if (!declaration?.initializer) throw new Error(`Generated source lacks ${exportName}`);
  const result = literal(declaration.initializer);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Generated source ${exportName} is not an object`);
  }
  return result as Record<string, unknown>;
}
