import { mcpOutputSchemas } from '../src/mcp-results';

/** Test helper: a successful tool result, as the bridge serializes it, must match the tool's declared output schema. */
export function checkedOutput<Result extends Record<string, unknown>>(name: string, result: Result): Result {
  if (result.state === 'error' || result.error !== undefined || !Object.hasOwn(mcpOutputSchemas, name)) return result;
  const parsed = mcpOutputSchemas[name as keyof typeof mcpOutputSchemas].safeParse(JSON.parse(JSON.stringify(result)));
  if (!parsed.success) throw new Error(name + ' result does not match its output schema: ' + parsed.error.message);
  return result;
}
