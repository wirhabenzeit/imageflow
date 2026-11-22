// Loopback test server for the Lightroom spike (experiment 5). No dependencies: `node server.mjs`.
// Mirrors the shape ADR 0011 proposes: bound to 127.0.0.1, bearer token, a long-poll endpoint the plugin waits on.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 7421);
const token = process.env.TOKEN ?? 'spike-token';

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const started = Date.now();
  const finish = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
    console.log(`${new Date().toISOString()} ${request.method} ${url.pathname}${url.search} → ${status} (${Date.now() - started} ms)`);
  };
  // The ADR also asks for a Host check against DNS rebinding.
  if (request.headers.host !== `127.0.0.1:${port}`) return finish(421, { error: 'bad host', host: request.headers.host });
  if (request.headers.authorization !== `Bearer ${token}`) return finish(401, { error: 'unauthorized' });
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (url.pathname === '/ping') return finish(200, { ok: true, echo: body });
    if (url.pathname === '/poll') {
      const hold = Math.min(Number(url.searchParams.get('hold') ?? 10), 60);
      const timer = setTimeout(() => finish(200, { job: null, held: hold }), hold * 1000);
      response.on('close', () => clearTimeout(timer)); // not request: it closes once the body is read
      return;
    }
    if (url.pathname === '/secret') return finish(200, { secret: true });
    finish(404, { error: 'not found' });
  });
});

server.listen(port, '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${port} (token: ${token})`));
