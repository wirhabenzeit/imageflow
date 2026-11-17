import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { advertisedSchemas, mcpOutputSchemas, mcpToolSchemas, mcpTools } from '../src/mcp-contract';

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
// add their entries and save results.
test('the advertised tool list stays within its size budget', () => {
  const bytes = (part: 'input' | 'output') => mcpTools.reduce((sum, { name }) => sum + JSON.stringify(advertisedSchemas(name)[part]).length, 0);
  const descriptions = mcpTools.reduce((sum, { title, description }) => sum + title.length + description.length, 0);
  assert.ok(bytes('input') + descriptions <= 45_000, 'Input schemas and descriptions use ' + (bytes('input') + descriptions) + ' bytes.');
  assert.ok(bytes('output') <= 28_000, 'Output schemas use ' + bytes('output') + ' bytes.');
});
