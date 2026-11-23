// The sync engine tests of tests/sync.test.ts once more, against the iCloud store over a fake CloudKit (`each` there).
// A file of its own, so the test runner gives it its own process beside the memory-store run.
process.env.IMAGEFLOW_SYNC_TEST_STORE = 'cloudkit';
await import('./sync.test');

export {};
