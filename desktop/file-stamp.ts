import type { BigIntStats } from 'node:fs';

/**
 * A file as cached content and photo renditions record it, to tell whether it changed. Not its device number: macOS
 * may give a volume another one after a restart, which made every cached digest and rendition look changed, so every
 * photo was hashed and rendered again (beta finding F-012). Callers compare the path beside it, and another file at
 * that path has another inode, size or change time.
 */
export const fileStamp = (info: BigIntStats) => [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
