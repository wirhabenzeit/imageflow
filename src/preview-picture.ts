// The page and layout thumbnail renderers enable this. Each book window owns a bounded, in-memory cache shared by
// its render sessions, scoped by the host to the template's code and current network permissions.
export async function previewPictureUrl(base: string, identity: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The cache is in the app's memory, so its answers are quick; on a busy, slow Mac a large picture can still take a few
// seconds to pass between processes. Giving up after 1 s, as before, dropped pictures the cache had, so they were drawn
// again, which takes far longer (beta CI flakiness).
export async function readPreviewPicture(url: string, signal: AbortSignal) {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), cache: 'no-store' });
    return response.ok ? await response.blob() : undefined;
  } catch { return undefined; }
}

export async function savePreviewPicture(url: string, blob: Blob) {
  try { await fetch(url, { method: 'PUT', body: blob, signal: AbortSignal.timeout(10_000) }); } catch { /* A cache miss must never break a picture. */ }
}
