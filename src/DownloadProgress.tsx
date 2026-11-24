import type { BookDownload } from './desktop';
import { Icon } from './Icon';

/** A book's download on its row (#305), in the Start window: a bar, how much is here, and Cancel. */
export function DownloadProgress({ download, title, cancel }: { download: BookDownload; title: string; cancel: () => void }) {
  const { done = 0, total } = download;
  const text = download.waiting ? 'Waiting…' : total === undefined ? 'Starting…' : done.toLocaleString('en') + ' of ' + total.toLocaleString('en');
  return <span className="book-progress" title={'Downloading “' + title + '”'}>
    <progress className="task-status-bar" max={total || 1} value={total ? Math.min(done, total) : 0} aria-label={'Downloading ' + title} />
    <span className="book-progress-line"><span className="book-progress-text">{text}</span>
      <button type="button" className="task-status-cancel" aria-label={'Cancel downloading ' + title} title="Cancel" onClick={cancel}><Icon name="close" size={10} /></button></span>
  </span>;
}
