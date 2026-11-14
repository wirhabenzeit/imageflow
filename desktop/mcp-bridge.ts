import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolve } from 'node:path';
import { advertisedSchemas, mcpLimits, mcpTools } from '../src/mcp-contract';
import { McpAppClient, McpConnectionError } from './mcp-connection';

function toolResult(result: Record<string, unknown>): CallToolResult {
  const { image, ...metadata } = result;
  const artwork = image as { data?: unknown; mimeType?: unknown } | undefined;
  const content: CallToolResult['content'] = [];
  if (artwork && typeof artwork.data === 'string' && (artwork.mimeType === 'image/png' || artwork.mimeType === 'image/jpeg')) {
    const { data, ...details } = artwork;
    metadata.image = details;
    content.push({ type: 'image', data, mimeType: artwork.mimeType });
  } else if (image !== undefined) metadata.image = image;
  content.unshift({ type: 'text', text: JSON.stringify(metadata) });
  const reply = {
    content,
    structuredContent: metadata as JSONObject,
    ...(result.state === 'error' || result.error !== undefined ? { isError: true } : {}),
  };
  // Include the text/structured metadata copies in the emitted payload budget.
  if (Buffer.byteLength(JSON.stringify(reply)) > mcpLimits.responseBytes - 1024) {
    return errorResult(new McpConnectionError('payload-too-large', 'The ImageFlow result exceeds 8 MiB. Request fewer results, fewer source files, or a smaller image.'));
  }
  return reply;
}

function errorResult(error: unknown): CallToolResult {
  return toolResult({ state: 'error', error: {
    code: error instanceof McpConnectionError ? error.code : 'bridge-error',
    message: error instanceof Error ? error.message : 'The ImageFlow request failed.',
  } });
}

function start() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--connection' || !args[1]) {
    throw new Error('Usage: node mcp-bridge.cjs --connection <ImageFlow connection file>');
  }
  const descriptorPath = resolve(args[1]);
  const handle = serveStdio(() => {
    const server = new McpServer({ name: 'imageflow', version: '0.1.0' }, {
      instructions: 'ImageFlow edits photo books that are open in the ImageFlow app. Call list_projects for a book handle, then get_authoring_context; ' +
        'its topics list the template API reference, and docs: ["authoring-workflow"] explains the order of work. Edit template files with ' +
        'workspace tools, save project data with apply_project_changes, and verify every edit with check_book.',
    });
    const app = new McpAppClient(descriptorPath, () => server.server.getClientVersion()?.name ?? 'MCP client');
    server.server.oninitialized = () => { void app.connect().catch(() => {}); };
    server.server.onclose = () => app.close();
    for (const tool of mcpTools) {
      const { input: schema, output } = advertisedSchemas(tool.name);
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(schema as Parameters<typeof fromJsonSchema>[0]),
        outputSchema: fromJsonSchema<Record<string, unknown>>(output as Parameters<typeof fromJsonSchema>[0]),
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, idempotentHint: true, openWorldHint: false },
      }, async (args, context) => {
        try { return toolResult(await app.call(tool.name, args, context.mcpReq.signal)); }
        catch (error) { return errorResult(error); }
      });
    }
    return server;
  }, {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: mcpLimits.requestBytes }),
    onerror: (error) => console.error(error.message),
  });
  process.once('SIGTERM', () => { void handle.close(); });
  process.once('SIGINT', () => { void handle.close(); });
}

try { start(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'ImageFlow MCP bridge failed to start.');
  process.exitCode = 1;
}
