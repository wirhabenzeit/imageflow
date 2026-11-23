// The sync engine tests of tests/sync.test.ts once more, against the S3 store (`each` there): over the fake server, or
// over a real bucket when IMAGEFLOW_S3_TEST_* name one (tests/s3-remote.ts). A file of its own, so the test runner gives
// it its own process beside the memory and folder runs.
import { after } from 'node:test';
import { cleanupS3 } from './s3-remote';

process.env.IMAGEFLOW_SYNC_TEST_STORE = 's3';
after(cleanupS3);
await import('./sync.test');

export {};
