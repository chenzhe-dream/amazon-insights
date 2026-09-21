import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const relative = (file: string) => path.relative(root, file).replaceAll('\\', '/');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;

// These are production task owners, not a test harness. HTTP orchestration remains here.
const owners = [
  'app/market-research-section.tsx', 'app/market-overview-section.tsx',
  'app/market-shape-section.tsx', 'app/market-keyword-section.tsx', 'app/market-theme-section.tsx',
];
const presentations = [
  'app/market-overview-report-view.tsx', 'app/market-overview-reference-sections.tsx',
  'app/lib/market-overview-presentation.ts', 'app/market-keyword-result-view-model.ts',
  'app/market-overview-analysis.tsx', 'app/market-overview-synthesis.tsx',
  'app/market-overview-distributions.tsx', 'app/market-overview-distribution-chart.tsx',
  'app/market-shape-report.tsx', 'app/market-shape-dashboard.tsx',
  'app/market-shape-structure-report.tsx', 'app/market-shape-product-table.tsx',
  'app/market-shape-explanation-report.tsx', 'app/market-keyword-report.tsx',
  'app/market-keyword-demand-summary.tsx', 'app/market-keyword-table.tsx',
  'app/market-keyword-rule-report.tsx', 'app/market-theme-result-view.tsx',
  'app/market-keyword-taxonomy-view.tsx',
];
type Edge = { specifier: string; dynamic?: boolean };

function runtimeEdges(source: string, fileName: string): Edge[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (node: ts.Expression | undefined, dynamic = false) => {
    assert.ok(node && ts.isStringLiteralLike(node), `${fileName}: computed runtime imports require explicit boundary review`);
    edges.push({ specifier: node.text, dynamic });
  };
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (!clause?.isTypeOnly && (!clause || clause.name || !bindings || ts.isNamespaceImport(bindings) || bindings.elements.length === 0 || bindings.elements.some(item => !item.isTypeOnly))) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause) || clause.elements.length === 0 || clause.elements.some(item => !item.isTypeOnly)) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0], true);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return edges;
}

const safePackages = /^(?:react(?:-dom)?(?:\/.*)?|zod(?:\/.*)?|next\/(?:link|navigation|image))$/;
function forbiddenLocal(file: string): boolean {
  const name = relative(file);
  return !/^(app|shared)\//.test(name)
    || /^app\/api\//.test(name)
    || /(?:^|\/)(?:reference|preview|fixtures?|providers?|collectors?|server)(?:\/|[.-])/.test(name)
    || /(?:^|[\/.-])(?:preview|fixtures?|synthetic|providers?|collectors?)(?:[\/.-]|$)/.test(name)
    || /(?:[.-](?:server|collector)|sellersprite-market-query|sorftime-.*\.server)\.[cm]?[jt]sx?$/.test(name);
}

function inspectGraph(entries: string[], pure: boolean) {
  const visited = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    const label = relative(file);
    assert.ok(existsSync(file), `Missing production boundary entry: ${label}`);
    assert.ok(!forbiddenLocal(file), `Forbidden runtime dependency: ${[...chain, label].join(' -> ')}`);
    if (visited.has(label)) return;
    visited.add(label);
    if (pure) assert.ok(!/^app\/lib\/(?:market-(?:overview|shape|keyword|theme|research)-browser|local-agent-browser)\./.test(label), `Presentation reaches HTTP orchestration: ${[...chain, label].join(' -> ')}`);
    const source = readFileSync(file, 'utf8');
    // A direct fetch in a pure view would otherwise bypass the import boundary.
    if (pure) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = node.expression;
          const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
          assert.ok(!['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].includes(name), `${label}: transport belongs in a task/read owner`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    for (const edge of runtimeEdges(source, file)) {
      const resolved = ts.resolveModuleName(edge.specifier, file, options, ts.sys).resolvedModule;
      if (resolved?.isExternalLibraryImport || (!resolved && !edge.specifier.startsWith('.') && !edge.specifier.startsWith('@/') && !path.isAbsolute(edge.specifier))) {
        assert.match(edge.specifier, safePackages, `Unreviewed external runtime dependency: ${[...chain, label, edge.specifier].join(' -> ')}`);
        continue;
      }
      assert.ok(resolved, `Cannot resolve ${label} -> ${edge.specifier}`);
      walk(resolved.resolvedFileName, [...chain, label]);
    }
  };
  for (const entry of entries) walk(path.join(root, entry), []);
  return visited;
}

test('AST boundary follows runtime imports/re-exports/dynamic imports and ignores explicit types', () => {
  const edges = runtimeEdges(`
    import type { Secret } from '../../server/secret';
    import { type Other } from '../../server/types';
    export type { More } from '../../server/more';
    export { type Last } from '../../server/last';
    import './side-effect';
    import { type Contract, render } from './mixed';
    export * from './barrel';
    export { render } from './export';
    const lazy = import('./dynamic');
    const common = require('./common');
    import legacy = require('./legacy');
  `, 'boundary-fixture.ts');
  assert.deepEqual(edges.map(edge => edge.specifier), ['./side-effect', './mixed', './barrel', './export', './dynamic', './common', './legacy']);
  assert.throws(() => runtimeEdges('import(destination)', 'computed.ts'), /computed runtime imports/);
  for (const file of ['server/services/collector.ts', 'app/api/route.ts', 'tests/fixture.ts', 'app/lib/preview.ts', 'app/lib/market-preview-transport.ts', 'app/market-synthetic-data.ts', 'app/lib/provider.server.ts', 'reference/app/report.tsx']) assert.equal(forbiddenLocal(path.join(root, file)), true, file);
});

test('production market entry graph cannot reach server/providers/reference or preview fixtures', () => {
  const graph = inspectGraph(owners, false);
  for (const entry of presentations) assert.ok(graph.has(entry), `${entry} must be reached by a production owner, not only tested in isolation`);
});

test('restored pure result views use only contracts and browser-safe presentation helpers', () => {
  inspectGraph(presentations, true);
});
