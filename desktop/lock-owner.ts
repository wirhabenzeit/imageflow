import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const proofFor = (token: string, challenge: string) => createHmac('sha256', token).update(challenge).digest('hex');

async function socketRoot() {
  // Darwin's per-user temporary path can exceed the Unix socket path limit.
  return realpath(process.platform === 'darwin' ? '/tmp' : tmpdir());
}

export async function createLockOwner(token: string) {
  const directory = await mkdtemp(join(await socketRoot(), 'if-owner-'));
  await chmod(directory, 0o700);
  const endpoint = join(directory, 's');
  const clients = new Set<Socket>();
  const server = net.createServer((socket) => {
    if (clients.size >= 8) { socket.destroy(); return; }
    clients.add(socket);
    socket.unref();
    socket.setTimeout(750, () => socket.destroy());
    let buffered = '';
    socket.on('data', (bytes: Buffer) => {
      buffered += bytes.toString('utf8');
      if (buffered.length > 128) { socket.destroy(); return; }
      if (!buffered.endsWith('\n')) return;
      const challenge = buffered.slice(0, -1);
      if (!/^[a-f0-9]{64}$/.test(challenge)) { socket.destroy(); return; }
      socket.end(proofFor(token, challenge) + '\n');
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
    });
    await chmod(endpoint, 0o600);
    server.unref();
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    endpoint,
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function isLockOwnerAlive(endpoint: string, token: string): Promise<boolean> {
  const directory = dirname(endpoint);
  if (!isAbsolute(endpoint) || basename(endpoint) !== 's' || !/^if-owner-[A-Za-z0-9]+$/.test(basename(directory)) ||
      dirname(directory) !== await socketRoot()) {
    throw new Error('The project writer endpoint is invalid. Its ownership record was preserved.');
  }
  for (const [path, socket] of [[directory, false], [endpoint, true]] as const) {
    const info = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return undefined;
    });
    if (!info) return false;
    if (info.isSymbolicLink() || (socket ? !info.isSocket() : !info.isDirectory()) || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) {
      throw new Error('The project writer endpoint is not private. Its ownership record was preserved.');
    }
  }
  return new Promise<boolean>((resolve, reject) => {
    const challenge = randomBytes(32).toString('hex');
    const expected = Buffer.from(proofFor(token, challenge));
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (alive?: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(alive!);
    };
    const unknown = () => finish(undefined, new Error('ImageFlow could not verify the project writer. Its ownership record was preserved.'));
    socket.setTimeout(750, unknown);
    socket.once('connect', () => socket.write(challenge + '\n'));
    let buffered = Buffer.alloc(0);
    socket.on('data', (bytes: Buffer) => {
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length > 65) { unknown(); return; }
      if (buffered.at(-1) !== 10) return;
      const proof = buffered.subarray(0, -1);
      if (proof.length === expected.length && timingSafeEqual(proof, expected)) finish(true);
      else unknown();
    });
    socket.once('error', (error) => {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ECONNREFUSED') finish(false);
      else finish(undefined, new Error('ImageFlow could not contact the project writer (' + (errorCode(error) ?? 'unknown error') + '). Its ownership record was preserved.'));
    });
    socket.once('end', unknown);
  });
}
