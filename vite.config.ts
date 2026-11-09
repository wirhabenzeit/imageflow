import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { layout, uploadLimit } from './src/spread';

const run = promisify(execFile);
const renderer = fileURLToPath(new URL('./.build/senja-export', import.meta.url));
const bookLimit = 150 * 1024 * 1024;

function sendError(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

async function exportBook(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Use POST to export a book.');
  }

  const { host, origin } = req.headers;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && origin !== 'http://' + host)) {
    return sendError(res, 403, 'Export requests must come from this local editor.');
  }
  const contentType = req.headers['content-type'];
  if (!contentType?.startsWith('multipart/form-data;')) {
    return sendError(res, 415, 'The book upload format is invalid.');
  }
  if (Number(req.headers['content-length']) > bookLimit) {
    return sendError(res, 413, 'This prototype supports up to 150 MB of photos per export.');
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bookLimit) {
      req.resume();
      return sendError(res, 413, 'This prototype supports up to 150 MB of photos per export.');
    }
    chunks.push(chunk);
  }

  let form: FormData;
  let spreads: unknown[];
  try {
    const body = new Uint8Array(Buffer.concat(chunks, size));
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
    const plan = form.get('book');
    if (typeof plan !== 'string' || plan.length > 1_000_000) throw new Error('Invalid book');
    ({ spreads } = JSON.parse(plan));
    if (!Array.isArray(spreads) || spreads.length < 1 || spreads.length > 30) throw new Error('Invalid book');
  } catch {
    return sendError(res, 400, 'The book layout could not be read.');
  }

  const folder = await mkdtemp(join(tmpdir(), 'senja-book-'));
  try {
    for (const [id, file] of form) {
      if (id === 'book') continue;
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || typeof file === 'string' || file.size > uploadLimit) {
        return sendError(res, 422, 'The book contains an invalid photo.');
      }
      const jpeg = Buffer.from(await file.arrayBuffer());
      if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[2] !== 255) {
        return sendError(res, 422, 'All book photos must be JPEG files.');
      }
      await writeFile(join(folder, id + '.jpg'), jpeg);
    }

    const planPath = join(folder, 'book.json');
    const output = join(folder, 'book.pdf');
    await writeFile(planPath, JSON.stringify({ layout, spreads }));
    try {
      await run(renderer, [planPath, output], { timeout: 60_000 });
    } catch (error) {
      const details = error as { code?: unknown; stderr?: string };
      if (details.code === 1 && details.stderr?.trim()) {
        return sendError(res, 422, details.stderr.trim());
      }
      throw error;
    }

    const pdf = await readFile(output);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="senja-photobook.pdf"',
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function localExport(): Plugin {
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.url !== '/api/book') return next();
    void exportBook(req, res).catch((error: unknown) => {
      console.error('Senja PDF export failed', error);
      if (!res.headersSent && !res.destroyed) {
        sendError(res, 500, 'PDF export failed. Check the local server terminal.');
      }
    });
  }

  return {
    name: 'senja-local-export',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [localExport()],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
