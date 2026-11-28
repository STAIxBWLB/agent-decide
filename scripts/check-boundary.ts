import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
// Usage: bun scripts/check-boundary.ts [project-root]; defaults to the current directory.
// Runtime code may import only relative files, Node builtins, bun: modules and exact-pinned first-party @staix/* packages
// listed in package.json dependencies. @staix/cli-output (the CLI output standard) is imported by src/output.ts only.
const root = process.argv[2] ?? ".";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps: Record<string, string> = pkg.dependencies ?? {};
const EXACT = /^\d+\.\d+\.\d+$/;
const allowed = new Set(Object.keys(deps).filter(name => name.startsWith("@staix/") && EXACT.test(deps[name]!)));
const ONLY_IN: Record<string, string> = { "@staix/cli-output": join(root, "src", "output.ts") };
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
        else if (allowed.has(spec.text)) { const only = ONLY_IN[spec.text]; if (only && file !== only) errors.push(`${file}: import ${spec.text} only from ${only}`); }
        else if (!(spec.text.startsWith(".") || builtins.has(spec.text) || spec.text.startsWith("bun:"))) errors.push(`${file}: forbidden dependency ${spec.text}`);
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && /\x1b|\\x1b|\\u001b|\\u\{1b\}|\\033/i.test(node.getText(source)))
        errors.push(`${file}: raw terminal escape; color goes through src/output.ts`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect(join(root, "src"));
for (const [name, version] of Object.entries(deps)) if (!allowed.has(name)) errors.push(`runtime dependency ${name}@${version}: only exact-pinned @staix/* packages are allowed`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("boundary: ok");
