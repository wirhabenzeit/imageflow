import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { advertisedSchemas, mcpOutputSchemas, mcpToolSchemas, mcpTools, parseMcpArguments } from '../src/mcp-contract';
import { parseActiveEditor } from '../src/mcp-results';
import { projectOperationNames, projectOperationSchema } from '../src/project-commands';

type JsonSchema = { description?: string; const?: unknown; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[];
  oneOf?: JsonSchema[]; allOf?: JsonSchema[]; additionalProperties?: JsonSchema | boolean };

// Every field an agent can send, at any depth, carries a description of what it means.
function undescribed(schema: JsonSchema, path: string): string[] {
  const nested = [...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? []].flatMap((variant) => undescribed(variant, path));
  // A constant discriminator, such as a command's op, is named by the description of its variant.
  const named = (value: JsonSchema) => value.description || (value.const !== undefined && schema.description);
  const properties = Object.entries(schema.properties ?? {}).flatMap(([key, value]) => [
    ...(named(value) ? [] : [path + '.' + key]), ...undescribed(value, path + '.' + key)]);
  const items = schema.items ? undescribed(schema.items, path + '[]') : [];
  const values = typeof schema.additionalProperties === 'object' ? undescribed(schema.additionalProperties, path + '{}') : [];
  return [...nested, ...properties, ...items, ...values];
}

test('every MCP tool has a title, a short description and a described argument tree', () => {
  assert.deepEqual(mcpTools.map(({ name }) => name).sort(), Object.keys(mcpToolSchemas).sort());
  for (const tool of mcpTools) {
    assert.ok(tool.title.length > 0 && tool.title.length <= 40, tool.name);
    // What the tool is for and when to call it; argument facts belong on the fields.
    assert.ok(tool.description.length <= 400, tool.name + ' description is ' + tool.description.length + ' characters.');
    const schema = z.toJSONSchema(mcpToolSchemas[tool.name], { io: 'input' }) as JsonSchema;
    assert.deepEqual(undescribed(schema, tool.name), []);
  }
});

test('every MCP tool declares an object output schema', () => {
  assert.deepEqual(Object.keys(mcpOutputSchemas).sort(), Object.keys(mcpToolSchemas).sort());
  for (const tool of mcpTools) {
    const schema = z.toJSONSchema(mcpOutputSchemas[tool.name], { io: 'output' }) as JsonSchema & { type?: string };
    assert.equal(schema.type, 'object', tool.name);
    assert.ok(schema.properties && Object.keys(schema.properties).length > 0, tool.name);
  }
});

test('the project commands reference gives a valid example of every operation', () => {
  const doc = readFileSync('docs/template-api/project-commands.md', 'utf8');
  const examples = [...doc.matchAll(/`(\{"op":.*?\})`/g)].map(([, source]) => projectOperationSchema.parse(JSON.parse(source)));
  assert.deepEqual(examples.map(({ op }) => op).sort(), [...projectOperationNames].sort());
});

test('output schemas keep the frozen result fields strict and allow later additions', () => {
  const checks = { bundle: 'passed', declarations: 'passed', layout: 'completed', typescript: 'not-run', fixtures: 'not-run', print: 'not-run' };
  const result = { state: 'ready', revision: 'a'.repeat(64), diagnostics: [{ code: 'x', stage: 'render', severity: 'warning', message: 'm', later: 1 }], checks, later: true };
  assert.ok(mcpOutputSchemas.check_book.safeParse(result).success);
  assert.equal(mcpOutputSchemas.check_book.safeParse({ ...result, revision: 'r1' }).success, false);
  assert.equal(mcpOutputSchemas.check_book.safeParse({ ...result, checks: { ...checks, layout: 'passed' } }).success, false);
  assert.equal(mcpOutputSchemas.check_book.safeParse({ ...result, diagnostics: [{ code: 'x', stage: 'render', severity: 'info', message: 'm' }] }).success, false);
});

// Clients load every tool schema into the agent's context before the first call. Descriptions belong on the fields,
// but a shared definition is emitted once, and the whole list stays within this budget.
// Page addressing and page-pair/blank/swap commands add schemas shared by drafts and saves; the template library tools
// add their entries and save results. The book history tool adds its entry and write results their checkpoint.
// inspect_book's cover view and its sources filter by kind add their options. rename_source adds its entry and result.
// inspect_book's photo choice and sheet (API-015) and fixture values (API-021) add their options and the sheet's metadata;
// the evening session's checkpoint lists and version notices (#330) theirs.
test('every tool names its parameters at the top level of its schema (API-016)', () => {
  for (const { name } of mcpTools) {
    const { input } = advertisedSchemas(name) as { input: { properties?: object; required?: string[]; anyOf?: unknown } };
    assert.ok(input.properties && !input.anyOf, name);
  }
  const imports = (args: object) => parseMcpArguments('import_sources', { project: 'book', expectedRevision: 'a'.repeat(64), idempotencyKey: 'k', paths: ['inbox/a.gpx'], ...args });
  assert.throws(() => imports({ kind: 'file' }), /accept: Name the extensions/);
  assert.throws(() => imports({ kind: 'photo', accept: ['.jpg'] }), /only for kind file/);
  assert.equal(imports({ kind: 'file', accept: ['.gpx'] }).args.kind, 'file');
});

test('the advertised tool list stays within its size budget', () => {
  const bytes = (part: 'input' | 'output') => mcpTools.reduce((sum, { name }) => sum + JSON.stringify(advertisedSchemas(name)[part]).length, 0);
  const descriptions = mcpTools.reduce((sum, { title, description }) => sum + title.length + description.length, 0);
  assert.ok(bytes('input') + descriptions <= 53_000, 'Input schemas and descriptions use ' + (bytes('input') + descriptions) + ' bytes.');
  assert.ok(bytes('output') <= 34_500, 'Output schemas use ' + bytes('output') + ' bytes.');
});

test('a preview target that fits one shape reports that shape\'s issue, otherwise the list of shapes', () => {
  const message = (target: unknown) => {
    try { parseMcpArguments('check_book', { project: 'p', preview: { target } }); } catch (error) { return (error as Error).message; }
    assert.fail('expected a validation error');
  };
  assert.match(message({ spread: 'bad id!' }), /^preview\.target\.spread: Use a spread ID/);
  assert.match(message({ spread: 'one', box: 'b', page: 'top' }), /^preview\.target\.page: .*left.*right/);
  assert.match(message({ foo: 1 }), /^preview\.target: Use \{spread\} for a spread/);
  assert.match(message({ spread: 'one', box: 'b', element: 'c' }), /^preview\.target: Use \{spread\} for a spread/);
});

test('an active editor reply from the window is parsed before it is trusted', () => {
  assert.deepEqual(parseActiveEditor({ label: 'Note', spread: 'one', page: 'left', extra: 1 }), { label: 'Note', spread: 'one', page: 'left' });
  assert.equal(parseActiveEditor('Note'), undefined);
  assert.equal(parseActiveEditor({ spread: 'one' }), undefined);
  assert.equal(parseActiveEditor({ label: 'Note', page: 'top' }), undefined);
});
