// Content security policies for render frames.

/** The render frame policy with network origins added for an element editor; unchanged without origins. */
export function editorPolicy(policy: string, origins: readonly string[]) {
  if (!origins.length) return policy;
  const list = origins.join(' ');
  return policy.replace("connect-src 'self'", "connect-src 'self' " + list).replace("img-src 'self' data:", "img-src 'self' data: blob: " + list)
    .replace("font-src 'self'", "font-src 'self' " + list) + "; worker-src 'self' blob:; child-src blob:";
}
