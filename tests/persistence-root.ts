import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePersistence } from '../desktop/persistence';

// Importing this gives a test file its own App Support persistence root (writer locks, journals, ledgers).
export const persistenceRoot = join(realpathSync(mkdtempSync(join(tmpdir(), 'imageflow-state-'))), 'persistence');
configurePersistence(persistenceRoot);
process.on('exit', () => rmSync(join(persistenceRoot, '..'), { recursive: true, force: true }));
