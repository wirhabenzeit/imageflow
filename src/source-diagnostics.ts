import type { Issue } from './desktop';

const unavailable = new Set(['source-unavailable', 'photo-missing', 'text-source-missing', 'file-unreadable', 'file-missing']);
export const isUnavailableSource = (issue: Pick<Issue, 'code'>) => unavailable.has(issue.code ?? '');
