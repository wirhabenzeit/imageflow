import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { McpLaunch } from '../src/desktop';

/** The bridge runs inside ImageFlow's own executable in Node mode, so agents need no separate Node installation and
 * the bridge always matches the installed app. The connection path is fixed per user; enabling the connection again
 * rotates its credentials without changing this launch configuration. */
export function bridgeLaunch(executable: string, bridge: string, descriptorPath: string): McpLaunch {
  return { command: executable, args: [bridge, '--connection', descriptorPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const quote = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export function claudeCodeCommand(launch: McpLaunch) {
  const env = Object.entries(launch.env).flatMap(([key, value]) => ['-e', key + '=' + value]);
  return ['claude', 'mcp', 'add', '--scope', 'user', ...env, 'imageflow', '--', launch.command, ...launch.args].map(quote).join(' ');
}

// ---- Claude Desktop extension (.mcpb) ----

/** Starts ImageFlow's bridge. Arguments: the ImageFlow executable, then the bridge arguments. A shell entry point
 * keeps the extension valid when Claude Desktop does not preserve file modes and explains a moved app. */
const launcherScript = `#!/bin/sh
if [ ! -x "$1" ]; then
  echo "ImageFlow is no longer at $1. Open ImageFlow, choose Connect an agent… and add it to Claude Desktop again." >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 exec "$@"
`;

export function claudeExtension(options: { launch: McpLaunch; version: string; tools: { name: string; description: string }[] }) {
  const { launch } = options;
  const manifest = {
    manifest_version: '0.2',
    name: 'imageflow',
    display_name: 'ImageFlow',
    version: options.version,
    description: 'Check, preview and edit the photo book open in ImageFlow.',
    long_description: 'Connects Claude to the ImageFlow app on this Mac. Keep ImageFlow open with agent access turned on. Edits go through ImageFlow with Undo.',
    author: { name: 'ImageFlow' },
    server: {
      type: 'binary',
      entry_point: 'server/imageflow-mcp.sh',
      mcp_config: { command: '/bin/sh', args: ['${__dirname}/server/imageflow-mcp.sh', launch.command, ...launch.args], env: launch.env },
    },
    tools: options.tools.map(({ name, description }) => ({ name, description })),
    compatibility: { platforms: ['darwin'] },
  };
  return zip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'server/imageflow-mcp.sh', data: Buffer.from(launcherScript), mode: 0o755 },
  ]);
}

/** Minimal stored (uncompressed) ZIP writer for the small extension bundle. */
export function zip(entries: { name: string; data: Buffer; mode?: number }[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS format keeps the archive reproducible.
  const time = 0, date = (1 << 5) | 1;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the external attributes carry file modes
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// ---- ChatGPT desktop and Codex (shared ~/.codex/config.toml) ----

function run(file: string, args: string[], timeout = 10000) {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
  });
}

const bundledCodex = 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/** The ChatGPT desktop app ships the Codex CLI. Otherwise look for `codex` on the user's login-shell PATH, which a
 * GUI app does not inherit. Every candidate must answer `--version`. */
export async function findCodex(candidates?: string[]) {
  const found = candidates ?? [join('/Applications', bundledCodex), join(homedir(), 'Applications', bundledCodex)];
  if (!candidates) {
    const shell = process.env.SHELL || '/bin/zsh';
    const resolved = await run(shell, ['-lc', 'command -v codex'], 5000).catch(() => '');
    const path = resolved.trim().split('\n').at(-1)?.trim();
    if (path?.startsWith('/')) found.push(path);
  }
  for (const path of found) {
    try {
      await access(path, constants.X_OK);
      await run(path, ['--version'], 5000);
      return path;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

/** Writes `[mcp_servers.imageflow]` through the Codex CLI, replacing an earlier ImageFlow entry. */
export async function addToCodex(codex: string, launch: McpLaunch) {
  const env = Object.entries(launch.env).flatMap(([key, value]) => ['--env', key + '=' + value]);
  await run(codex, ['mcp', 'add', 'imageflow', ...env, '--', launch.command, ...launch.args]);
}
