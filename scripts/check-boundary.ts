import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
// Usage: bun scripts/check-boundary.ts [project-root]; defaults to the current directory.
// Runtime code may import only relative files, Node builtins and bun: modules (zero runtime dependencies).
const root = process.argv[2] ?? ".";
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const errors: string[] = [];
function inspect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { inspect(file); continue; }
    if (!file.endsWith(".ts")) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      let spec: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) spec = node.arguments[0];
      if (spec) {
        if (!ts.isStringLiteral(spec)) errors.push(`${file}: nonliteral import`);
        else if (!(spec.text.startsWith(".") || builtins.has(spec.text) || spec.text.startsWith("bun:"))) errors.push(`${file}: forbidden dependency ${spec.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect(join(root, "src"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) errors.push("runtime dependencies must be empty");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("boundary: ok");
