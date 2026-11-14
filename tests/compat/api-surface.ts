import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { advertisedSchemas, mcpTools } from '../../src/mcp-contract';
import { bookFormatVersion, photoIndexSchema, projectSchema } from '../../src/project';
import { capabilities, contract1Capabilities, runtimeExports } from '../../src/runtime-exports';

// The surfaces that existing books, templates and agents depend on, as plain JSON for tests/compat/api-snapshot.json.
// Descriptions and doc comments are left out, so rewording help text is not reported as an API change.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function withoutDescriptions(value: unknown): Json {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description' && key !== '$schema')
      .map(([key, entry]) => [key, withoutDescriptions(entry)]));
  }
  return value as Json;
}

const schema = (type: z.ZodType) => withoutDescriptions(z.toJSONSchema(type, { io: 'input', unrepresentable: 'any' }));

// Each top-level declaration of a shipped .d.ts file, printed without comments, keyed by its name.
function declarations(path: string) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true });
  const result: Record<string, string> = {};
  source.statements.forEach((statement, index) => {
    const name = (statement as { name?: ts.Node }).name;
    let key = name ? name.getText(source) : ts.SyntaxKind[statement.kind] + ' #' + index;
    // Overloads share a name.
    for (let n = 2; Object.hasOwn(result, key); n++) key = (name ? name.getText(source) : key) + ' (' + n + ')';
    result[key] = printer.printNode(ts.EmitHint.Unspecified, statement, source).replace(/\s+/g, ' ');
  });
  return result;
}

export function apiSurface(root: string) {
  return {
    bookFormat: {
      schemaVersion: bookFormatVersion,
      'project.json': schema(projectSchema),
      'photos.json': schema(photoIndexSchema),
    },
    templateApi: {
      runtimeExports: [...runtimeExports],
      contract1Capabilities: [...contract1Capabilities],
      capabilities: [...capabilities],
      declarations: Object.fromEntries(['imageflow.d.ts', 'jsx-runtime.d.ts', 'assets.d.ts', 'react.d.ts']
        .map((file) => [file, declarations(join(root, 'authoring', file))])),
    },
    mcp: Object.fromEntries(mcpTools.map(({ name, readOnly }) => {
      const { input, output } = advertisedSchemas(name);
      return [name, { readOnly, input: withoutDescriptions(input), output: withoutDescriptions(output) }];
    })),
  };
}

export type ApiSurface = ReturnType<typeof apiSurface>;

// Leaf values by JSON path, for reporting what was added, removed or changed between two surfaces. A list of plain
// values (capabilities, enum members, required fields) is a set: each member is its own path.
export function flatten(value: unknown, path = '', into: Record<string, string> = {}) {
  const at = (key: string) => path ? path + ' › ' + key : key;
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
    if (!value.length) into[path] = '[]';
    for (const item of value) into[at(JSON.stringify(item))] = 'listed';
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) into[path] = JSON.stringify(value);
    for (const [key, entry] of entries) flatten(entry, at(key), into);
  } else {
    into[path] = JSON.stringify(value);
  }
  return into;
}

export type SurfaceChanges = { section: string; added: string[]; removed: string[]; changed: string[] };

export function compareSurfaces(before: unknown, after: unknown): SurfaceChanges[] {
  const sections = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...sections].map((section) => {
    const [a, b] = [flatten((before as Record<string, unknown>)?.[section]), flatten((after as Record<string, unknown>)?.[section])];
    return {
      section,
      added: Object.keys(b).filter((key) => !Object.hasOwn(a, key)),
      removed: Object.keys(a).filter((key) => !Object.hasOwn(b, key)),
      changed: Object.keys(b).filter((key) => Object.hasOwn(a, key) && a[key] !== b[key]),
    };
  }).filter(({ added, removed, changed }) => added.length + removed.length + changed.length);
}
