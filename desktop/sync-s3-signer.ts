import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3-compatible services (#281), written out instead of taken from a library: it is about
 * fifty lines, works on a payload hash the caller already has (so an original is never read twice to sign it), and
 * keeps the app free of a dependency for one function. tests/s3-fake.ts checks every request with the same rules.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
export type S3Credentials = { accessKeyId: string; secretAccessKey: string };

export const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters, `/` kept in paths. */
export function uriEncode(value: string, keepSlash = false) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/** `20261123T101500Z` */
export const amzDate = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export type SignInput = {
  method: string;
  url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`; names in any case. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body (`emptySha256` without one). */
  payloadSha256: string;
  region: string;
  credentials: S3Credentials;
  now?: Date;
};

/** The canonical request of SigV4 (also used by the fake server to check a request it receives). */
export function canonicalRequest(method: string, url: URL, headers: Record<string, string>, payloadSha256: string) {
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const query = [...url.searchParams].map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([name, value]) => name + '=' + value).join('&');
  // The URL's path is already percent-encoded the way it was sent; S3 signs it as sent, without encoding it again.
  return [method, url.pathname || '/', query, names.map((name) => name + ':' + lower[name].trim().replace(/\s+/g, ' ') + '\n').join(''), names.join(';'), payloadSha256].join('\n');
}

export function signingKey(secret: string, day: string, region: string) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
}

/** The headers to send with a request: the caller's, plus `x-amz-date`, `x-amz-content-sha256` and `authorization`. */
export function signRequest({ method, url, headers, payloadSha256, region, credentials, now = new Date() }: SignInput): Record<string, string> {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const signed: Record<string, string> = { ...headers, host: url.host, 'x-amz-date': date, 'x-amz-content-sha256': payloadSha256 };
  const request = canonicalRequest(method, url, signed, payloadSha256);
  const scope = day + '/' + region + '/s3/aws4_request';
  const signature = hmac(signingKey(credentials.secretAccessKey, day, region), ['AWS4-HMAC-SHA256', date, scope, sha256Hex(request)].join('\n')).toString('hex');
  const names = Object.keys(signed).map((name) => name.toLowerCase()).sort().join(';');
  const { host: _, ...rest } = signed;
  return { ...rest, authorization: 'AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/' + scope + ', SignedHeaders=' + names + ', Signature=' + signature };
}
