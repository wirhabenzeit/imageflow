/**
 * The endpoint of an S3-compatible bucket as people paste it (#281). Services show the S3 URL with the bucket in it:
 * Cloudflare R2 as `https://<account>.r2.cloudflarestorage.com/<bucket>`, AWS often virtual-hosted as
 * `https://<bucket>.s3.<region>.amazonaws.com`. Settings → Sync and the main process both split such a URL into the
 * server and the bucket, so a stored setting names only the server. Pure: no Node, so the renderer uses it too.
 */
export type SplitEndpoint = { endpoint: string; bucket?: string; region?: string } | { error: string };

const enter = 'Enter the server address, like https://<account>.r2.cloudflarestorage.com, and the bucket separately.';
const awsRegion = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/;

export function splitEndpoint(value: string): SplitEndpoint {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return { error: 'The endpoint is not a URL.' }; }
  if (url.username || url.password) return { error: 'The endpoint holds no user name or password; the access key goes in its own fields.' };
  if (url.search || url.hash) return { error: enter };
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 1) return { error: enter };
  let bucket: string | undefined;
  if (segments.length === 1) {
    try { bucket = decodeURIComponent(segments[0]); } catch { return { error: enter }; }
  }
  // AWS, virtual-hosted: <bucket>.s3.amazonaws.com, <bucket>.s3.<region>.amazonaws.com or <bucket>.s3-<region>.amazonaws.com.
  const aws = /^(.+)\.s3(?:([.-])([a-z0-9-]+))?\.amazonaws\.com$/.exec(url.hostname);
  if (aws && !bucket) {
    const [, name, separator, region] = aws;
    // A dotted name could be a bucket or part of the host, and fails TLS virtual-hosted anyway: asked for instead.
    if (name.includes('.') || (region !== undefined && !awsRegion.test(region)) || (separator === '-' && !region)) {
      return { error: 'Enter the regional S3 endpoint, like https://s3.eu-central-1.amazonaws.com, and the bucket separately.' };
    }
    return { endpoint: url.protocol + '//s3' + (region ? '.' + region : '') + '.amazonaws.com' + (url.port ? ':' + url.port : ''), bucket: name, ...(region ? { region } : {}) };
  }
  // Another AWS host with a bucket in it (dual-stack, accelerate, an access point): not split by guessing.
  if (/\.amazonaws\.com$/.test(url.hostname) && !/^s3[.-]/.test(url.hostname)) {
    return { error: 'Enter the regional S3 endpoint, like https://s3.eu-central-1.amazonaws.com, and the bucket separately.' };
  }
  return { endpoint: url.origin, ...(bucket ? { bucket } : {}) };
}
