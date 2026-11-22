import { Icon } from './Icon';
import type { TaskProgress } from './desktop';

/** A progress report as it arrives: plain text from older senders, or a `TaskProgress`. */
export const taskProgress = (value: string | TaskProgress): TaskProgress => typeof value === 'string' ? { text: value } : value;

/**
 * A long task in a status line, laid out so nothing moves while it runs: a bar of fixed width first (filling when the
 * task counts something, sliding when it does not), the count, the short label, and a small Cancel button.
 */
export function TaskStatus({ progress, cancel }: { progress: TaskProgress; cancel?: () => void }) {
  const counted = progress.total !== undefined && progress.total > 0;
  return <span className="task-status" title={progress.text + (counted ? ' · ' + (progress.done ?? 0) + ' of ' + progress.total : '')}>
    {counted ? <progress className="task-status-bar" max={progress.total} value={Math.min(progress.done ?? 0, progress.total!)} aria-label={progress.text} />
      : <span className="task-status-bar task-status-bar-indeterminate" role="progressbar" aria-label={progress.text}><span /></span>}
    {counted && <span className="task-status-count" aria-label={(progress.done ?? 0) + ' of ' + progress.total}>{progress.done ?? 0}/{progress.total}</span>}
    <span className="task-status-text">{progress.text}</span>
    {cancel && <button type="button" className="task-status-cancel" aria-label="Cancel" title="Cancel" onClick={cancel}><Icon name="close" size={10} /></button>}
  </span>;
}
