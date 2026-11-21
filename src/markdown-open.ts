import type { DesktopApi } from './desktop';

/** Opens ImageFlow's Markdown editor for a text of the book, or a new one; waits briefly while the book is busy. */
export async function openMarkdown(api: DesktopApi, request: { id: string } | { name: string }) {
  for (let attempt = 0; ; attempt++) {
    const result = await api.showMarkdown(request);
    if (!('error' in result) || result.code !== 'BOOK_BUSY' || attempt >= 30) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
