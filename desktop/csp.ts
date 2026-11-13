// Content security policies for render frames.

/**
 * The render frame policy. Pictures drawn by <RenderedImage> are shown from blob: URLs. With network origins the
 * user allowed for the book's template (ADR 0006), the frame may also fetch from them, load images and fonts from
 * them, and run blob workers, as map libraries do.
 */
export function renderPolicy(policy: string, origins: readonly string[]) {
  const list = origins.length ? ' ' + origins.join(' ') : '';
  const images = policy.replace("img-src 'self' data:", "img-src 'self' data: blob:" + list);
  if (!origins.length) return images;
  return images.replace("connect-src 'self'", "connect-src 'self'" + list).replace("font-src 'self'", "font-src 'self'" + list) +
    "; worker-src 'self' blob:; child-src blob:";
}
