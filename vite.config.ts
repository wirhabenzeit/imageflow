import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { ExportError, readBookForm, withBookPdf } from './server/book-export';

const renderer = fileURLToPath(new URL('./.build/senja-export', import.meta.url));

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
  const form = await readBookForm(req.headers['content-type'], req.headers['content-length'],
    req.iterator({ destroyOnReturn: false }));
  const pdf = await withBookPdf(form, renderer, readFile);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="senja-photobook.pdf"',
    'Content-Length': pdf.length,
    'Cache-Control': 'no-store',
  });
  res.end(pdf);
}

function localExport(): Plugin {
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.url !== '/api/book') return next();
    void exportBook(req, res).catch((error: unknown) => {
      if (error instanceof ExportError) {
        req.resume();
        if (!res.destroyed) sendError(res, error.status, error.message);
        return;
      }
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
