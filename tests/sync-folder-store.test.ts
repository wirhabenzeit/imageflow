// The sync engine tests of tests/sync.test.ts once more, against the folder store (`each` there). A file of its own, so
// the test runner gives it its own process beside the memory-store run.
process.env.IMAGEFLOW_SYNC_TEST_STORE = 'folder';
await import('./sync.test');

export {};
