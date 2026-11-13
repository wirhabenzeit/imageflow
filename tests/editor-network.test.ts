import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPolicy } from '../desktop/csp';
import { templateSchema } from '../src/template';

const offline = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:";

test('a render frame policy adds only the allowed origins, plus blob workers for libraries that need them', () => {
  assert.equal(renderPolicy(offline, []), offline.replace("img-src 'self' data:", "img-src 'self' data: blob:"), 'offline frames show drawn pictures only');
  assert.match(renderPolicy(offline, []), /connect-src 'self';/);
  const policy = renderPolicy(offline, ['https://tiles.example.com', 'https://*.maps.example']);
  assert.match(policy, /connect-src 'self' https:\/\/tiles\.example\.com https:\/\/\*\.maps\.example;/);
  assert.match(policy, /img-src 'self' data: blob: https:\/\/tiles\.example\.com https:\/\/\*\.maps\.example/);
  assert.match(policy, /font-src 'self' https:\/\/tiles\.example\.com/);
  assert.match(policy, /worker-src 'self' blob:; child-src blob:$/);
  // Scripts still come only from the book's own bundle.
  assert.match(policy, /script-src 'self';/);
});

test('templates declare network origins as bare HTTPS origins', () => {
  const declaration = (network: string[]) => templateSchema.safeParse({ id: 't', version: '1', contract: 1, network,
    format: { label: 'F', trim: { width: { unit: 'mm', value: 100 }, height: { unit: 'mm', value: 100 } },
      bleed: { top: { unit: 'mm', value: 0 }, bottom: { unit: 'mm', value: 0 }, outside: { unit: 'mm', value: 0 }, binding: { unit: 'mm', value: 0 } },
      safe: { top: { unit: 'mm', value: 0 }, bottom: { unit: 'mm', value: 0 }, outside: { unit: 'mm', value: 0 }, binding: { unit: 'mm', value: 0 } },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 10, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
    spreads: { main: { label: 'Main', render: () => null } } });
  assert.ok(declaration(['https://tiles.openfreemap.org', 'https://*.example.com', 'https://localhost.test:8443']).success);
  for (const bad of ['http://tiles.example.com', 'https://tiles.example.com/styles', 'https://*', '*', 'https://*.*.example.com', "https://x.com 'unsafe-eval'"]) {
    assert.ok(!declaration([bad]).success, bad);
  }
});
