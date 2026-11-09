import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { layout, uploadLimit } from '../src/spread';

const run = promisify(execFile);
const bookLimit = 150 * 1024 * 1024;
const sizeError = 'This prototype supports up to 150 MB of photos per export.';

export class ExportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readBookForm(
  contentType: string | null | undefined,
  contentLength: string | null | undefined,
  body: AsyncIterable<Uint8Array>,
) {
  if (!contentType?.startsWith('multipart/form-data;')) {
    throw new ExportError(415, 'The book upload format is invalid.');
  }
  if (Number(contentLength) > bookLimit) throw new ExportError(413, sizeError);

  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > bookLimit) throw new ExportError(413, sizeError);
    chunks.push(chunk);
  }

  try {
    const bytes = new Uint8Array(Buffer.concat(chunks, size));
    return await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new ExportError(400, 'The book layout could not be read.');
  }
}

export async function withBookPdf<T>(
  form: FormData,
  renderer: string,
  usePdf: (output: string) => Promise<T>,
): Promise<T> {
  let spreads: unknown[];
  try {
    const plan = form.get('book');
    if (typeof plan !== 'string' || plan.length > 1_000_000) throw new Error('Invalid book');
    ({ spreads } = JSON.parse(plan));
    if (!Array.isArray(spreads) || spreads.length < 1 || spreads.length > 30) throw new Error('Invalid book');
  } catch {
    throw new ExportError(400, 'The book layout could not be read.');
  }

  const folder = await mkdtemp(join(tmpdir(), 'senja-book-'));
  try {
    for (const [id, file] of form) {
      if (id === 'book') continue;
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || typeof file === 'string' || file.size > uploadLimit) {
        throw new ExportError(422, 'The book contains an invalid photo.');
      }
      const jpeg = Buffer.from(await file.arrayBuffer());
      if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[2] !== 255) {
        throw new ExportError(422, 'All book photos must be JPEG files.');
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
        throw new ExportError(422, details.stderr.trim());
      }
      throw error;
    }

    return await usePdf(output);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
