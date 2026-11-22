import { EditMarkdown, NewMarkdown } from './MarkdownActions';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DesktopApi, ProjectSummary, SourceAction } from './desktop';
import { PhotoViewMenu } from './PhotoViewMenu';
import type { PhotoViewControl } from './PhotoViewMenu';
import { photoGroups, photoDate, captureLabel } from './photo-view';
import { sourceList } from './source-items';
import { sourceEntries, sourceFile, sourceFolderName, sourceProvider } from './source-locations';
import { useListSelection } from './list-selection';
import { fileExtensionMime, fileMime, photoMime, textMime } from './source-items';
import type { SourceRef } from './source-items';
import type { SourceKind } from './source-locations';
import { assetMenu, assetMenuState, assetActions } from './asset-menu';
import { assetPageLabels, assetUsage } from './asset-usage';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { fileExtension, useFileIcons } from './file-icons';

// The Assets window shows photo thumbnails. Embedded in a book window's bottom panel it is a plain list: the
// panel's tab buttons share its toolbar, every asset shows its system document icon, and dragging an asset
// starts an in-app drag onto a page rather than a file drag to Finder.
const Glyph = ({ kind }: { kind: SourceKind }) => <span aria-hidden="true">{kind === 'photo' ? '▧' : kind === 'markdown' ? 'Aa' : '▤'}</span>;
const DocumentIcon = ({ src, kind }: { src?: string; kind: SourceKind }) => src ? <img src={src} alt="" draggable={false} /> : <Glyph kind={kind} />;

export function SourceManager({ view, api, summary, adopt, disabled = false, quickLook, embedded = false, tabs, importFiles, fileTypes = [] }: {
  view: PhotoViewControl; api: DesktopApi; summary: ProjectSummary; adopt: (summary: ProjectSummary) => void; disabled?: boolean; quickLook?: (source: SourceRef) => void;
  embedded?: boolean; tabs?: ReactNode;
  // Imports dropped files, or asks for files to import when none are given. The book window routes this through its own
  // import queue; the Assets window leaves it unset and imports through the asset actions.
  importFiles?: (files?: File[]) => void;
  // Embedded in a book window the list holds only files, and importing takes these extensions.
  fileTypes?: string[];
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<{ message: string; code?: string }>();
  const [notice, setNotice] = useState('');
  // The asset whose name is being edited in its row (Rename…).
  const [renaming, setRenaming] = useState<string>();
  const [kind, setKind] = useState('all');
  const [used, setUsed] = useState('all');
  const [storage, setStorage] = useState('all');
  const [attention, setAttention] = useState(false);
  const [search, setSearch] = useState('');
  const raw = sourceEntries(summary);
  // The bottom panel's Assets tab holds the files of file parameters; photos and texts have their own tabs there.
  const entries = embedded ? raw.filter((entry) => entry.kind === 'file')
    : [...sourceList(summary, 'photo', view.value).map(({ id }) => raw.find((entry) => entry.kind === 'photo' && entry.id === id)!), ...raw.filter((entry) => entry.kind !== 'photo')];
  const usage = assetUsage(summary, assetPageLabels(summary));
  const documentIcon = useFileIcons(embedded ? entries.map((entry) => fileExtension(entry.name)) : []);
  const placements = (entry: typeof entries[number]) => usage[entry.kind === 'markdown' ? 'text' : entry.kind][entry.id] ?? [];
  const unavailable = (key: string) => !!summary.sources?.[key] && summary.sources[key].state !== 'available';
  const linked = entries.filter((entry) => sourceFile(entry)?.linked).length;
  const missing = entries.filter((entry) => unavailable(entry.key)).length;
  async function act(request: SourceAction) {
    setBusy(true); setError(undefined); setNotice('');
    try {
      let result = await api.sourceAction(request);
      // Background book checks can briefly own the document. A busy response has not started the action.
      for (let attempt = 0; 'error' in result && result.code === 'BOOK_BUSY' && attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!mounted.current) return;
        result = await api.sourceAction(request);
      }
      if ('error' in result) setError({ message: result.error, code: result.code });
      else { adopt(result.value.summary); setNotice(result.value.message ?? ''); }
    } catch (error) { setError({ message: error instanceof Error ? error.message : 'Could not update assets.' }); }
    finally { setBusy(false); }
  }
  const bring = (files?: File[]) => {
    if (importFiles) importFiles(files);
    else void act({ action: 'import', paths: files && api.pathsForFiles(files) });
  };
  async function menu(keys: string[]) {
    if (busy || disabled || !keys.length) return;
    const result = await api.showContextMenu(assetMenu(summary, keys, true), assetMenuState(busy || disabled));
    if (!result) return;
    if (result.command === 'asset-preview') {
      const item = sourceEntries(summary).find(({ key }) => key === keys[0]);
      if (item?.kind === 'file') await act({ action: 'preview', keys });
      else if (item) quickLook?.({ kind: item.kind === 'photo' ? 'photo' : 'text', id: item.id });
    } else if (result.command === 'asset-rename') setRenaming(keys[0]);
    else if (result.command === 'asset-jump') await act({ action: 'jump', spread: result.value });
    else if (result.command in assetActions) await act({ action: assetActions[result.command as keyof typeof assetActions], keys });
  }
  const locked = busy || disabled;
  const shown = entries.filter((entry) => (kind === 'all' || kind === entry.kind) &&
    (used === 'all' || (used === 'used') === !!placements(entry).length) &&
    // Linked: anything not stored in the book, whether a file elsewhere or a photo of another provider.
    (storage === 'all' || (storage === 'linked') === (sourceProvider(entry) !== 'package')) && (!attention || unavailable(entry.key)) &&
    entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const groups = photoGroups(summary, shown.filter((entry) => entry.kind === 'photo').map(({ id }) => id), view.value);
  const headers = new Map(groups.filter((group) => group.label).map((group) => [group.ids[0], group]));
  const list = useListSelection(shown.map(({ key }) => key), (key) => entries.find((entry) => entry.key === key)!.name);
  const chosen = entries.filter(({ key }) => list.selected.includes(key));
  // Copy into Book copies a linked file; a photo of another provider is not copied yet.
  const copyable = (entry: typeof entries[number]) => !!sourceFile(entry)?.linked;
  const copyCount = chosen.filter(copyable).length;
  // With nothing selected, the buttons act on every asset of the list; the embedded list holds only files.
  const everyKey = embedded ? (keep: (entry: typeof entries[number]) => boolean) => entries.filter(keep).map(({ key }) => key) : () => undefined;
  const copyKeys = chosen.length ? chosen.filter(copyable).map(({ key }) => key) : everyKey(copyable);
  const preview = () => {
    const item = entries.find(({ key }) => key === list.selected[0]);
    if (item?.kind === 'file') void act({ action: 'preview', key: item.key });
    else if (item) quickLook?.({ kind: item.kind === 'photo' ? 'photo' : 'text', id: item.id });
  };
  return <section className={embedded ? 'sources source-manager source-manager-embedded' : 'source-manager'} aria-label={embedded ? 'Sources' : 'Assets'} aria-busy={busy || disabled}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={(event) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); if (!locked) bring([...event.dataTransfer.files]); }}>
    <header className={embedded ? 'sources-bar asset-toolbar' : 'asset-toolbar'}>
      {tabs}
      <input type="search" aria-label="Search assets" placeholder="Search assets" value={search} onChange={(event) => setSearch(event.target.value)} />
      {!embedded && <NewMarkdown api={api} disabled={locked} />}
      <button type="button" className="new-markdown" disabled={locked || (embedded && !fileTypes.length)} onClick={() => bring()}
        title={embedded ? fileTypes.length ? 'Import ' + fileTypes.join(', ') + ' files' : 'This template has no file parameters' : 'Import photos, texts and files for the template\'s file parameters'}><Icon name="down" /> Import…</button>
      {!embedded && <PhotoViewMenu view={view.value} update={view.update} custom={view.custom} />}
      <ActionMenu className="asset-filter" label={<>Filter <Icon name="chevron" /></>}>
        {!embedded && <>{(['photo', 'markdown', 'file'] as const).map((value) => <button key={value} onClick={() => setKind(kind === value ? 'all' : value)}>{({ photo: 'Photos', markdown: 'Markdown', file: 'Files' })[value]}</button>)}
        <hr /></>}
        <button onClick={() => setUsed(used === 'unused' ? 'all' : 'unused')}>Unused</button>
        <button onClick={() => setUsed(used === 'used' ? 'all' : 'used')}>Used</button>
        <hr />
        <button onClick={() => setStorage(storage === 'linked' ? 'all' : 'linked')}>Linked</button>
        <button onClick={() => setStorage(storage === 'book' ? 'all' : 'book')}>In Book</button>
        <button onClick={() => setAttention(!attention)}>Needs attention</button>
      </ActionMenu>
    </header>
    {(kind !== 'all' || used !== 'all' || storage !== 'all' || attention) && <div className="asset-filter-tokens" aria-label="Active filters">
      {kind !== 'all' && <button onClick={() => setKind('all')} aria-label="Remove kind filter">Kind: {kind} ×</button>}
      {used !== 'all' && <button onClick={() => setUsed('all')} aria-label="Remove usage filter">{used === 'unused' ? 'Unused' : 'Used'} ×</button>}
      {storage !== 'all' && <button onClick={() => setStorage('all')} aria-label="Remove storage filter">{storage === 'linked' ? 'Linked' : 'In Book'} ×</button>}
      {attention && <button onClick={() => setAttention(false)} aria-label="Remove attention filter">Needs attention ×</button>}
    </div>}
    <div className="source-manager-list" role="listbox" aria-label="Assets" aria-multiselectable="true" onKeyDown={(event) => {
      if (event.key === ' ') { event.preventDefault(); preview(); }
      else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (!locked && list.selected.length) void act({ action: 'remove', keys: list.selected }); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(list.selected); }
      else if (event.key === 'Enter' && !locked && list.selected.length) void act({ action: 'reveal', keys: list.selected });
      else list.key(event);
    }}>
      {shown.map((entry) => {
        const status = summary.sources?.[entry.key];
        const problem = unavailable(entry.key);
        const badge = problem ? status?.state === 'unapproved' ? 'Locate to approve' : status?.state === 'missing' ? 'Missing'
          : status?.state === 'denied' ? 'Access denied' : status?.state === 'offline' ? 'Offline' : status?.state === 'needs-sign-in' ? 'Sign in needed' : 'Unavailable' : undefined;
        const file = sourceFile(entry);
        const group = entry.kind === 'photo' ? headers.get(entry.id) : undefined;
        return <Fragment key={entry.key}>
          {group && <button className="asset-group-heading" onClick={() => list.setSelection(group.ids.map((id) => 'photo:' + id))}>
            {group.label} · {group.ids.length === group.total ? group.total : group.ids.length + ' of ' + group.total}</button>}
          <div role="option" aria-selected={list.selected.includes(entry.key)} key={entry.key} data-source={entry.key} data-list-id={entry.key}
          className="asset-row" tabIndex={(list.focused ?? shown[0]?.key) === entry.key ? 0 : -1} draggable={!locked && !problem && renaming !== entry.key && (!embedded || entry.kind === 'file')}
          onClick={(event) => list.choose(entry.key, event)}
          onContextMenu={(event) => void menu(list.context(entry.key, event))}
          onDragStart={(event) => {
            // In the bottom panel a file goes to a file setting in the Inspector (F-028).
            if (embedded) {
              const extension = entry.name.match(/\.[^.]+$/)?.[0] ?? '';
              event.dataTransfer.setData(fileMime, entry.id);
              event.dataTransfer.setData(fileExtensionMime(extension), '');
              event.dataTransfer.effectAllowed = 'link';
              return;
            }
            const keys = list.selected.includes(entry.key) ? list.selected : [entry.key];
            if (entry.kind === 'photo') event.dataTransfer.setData(photoMime, entry.id);
            if (entry.kind === 'markdown') event.dataTransfer.setData(textMime, entry.id);
            event.preventDefault(); void api.dragSources(keys);
          }}
          onDoubleClick={() => {
            if (embedded) { if (!locked && !problem) preview(); return; }
            if (!locked && !problem) void act({ action: 'reveal', keys: list.selected.includes(entry.key) ? list.selected : [entry.key] });
          }}>
          <span className={'asset-icon' + (embedded ? ' asset-icon-document' : '')}>{embedded ? <DocumentIcon src={documentIcon(fileExtension(entry.name))} kind={entry.kind} />
            : entry.kind === 'photo' && summary.photos[entry.id] ? <img src={summary.photos[entry.id]} alt="" /> : <Glyph kind={entry.kind} />}</span>
          <span className="asset-name" title={file?.path ?? entry.name}><span className="asset-description">{renaming === entry.key
            ? <RenameField name={entry.name} done={(name) => {
                setRenaming(undefined);
                if (name !== undefined && name !== entry.name) void act({ action: 'rename', key: entry.key, name });
              }} />
            : <strong>{entry.name}</strong>}
            {(file?.linked || problem) && sourceFolderName(entry) && <span className="muted">{sourceFolderName(entry)}</span>}</span></span>
          <span className="asset-status">{entry.kind === 'markdown' && <EditMarkdown api={api} id={entry.id} name={entry.name} disabled={locked || problem} failure={(message) => setError({ message })} />}{entry.kind === 'photo' && view.value.showTime && <span className="muted" title={photoDate(summary, entry.id)?.capturedEstimated ? 'Estimated from file modification time' : undefined}>{captureLabel(photoDate(summary, entry.id)?.captured, photoDate(summary, entry.id)?.capturedEstimated)}{photoDate(summary, entry.id)?.capturedEstimated ? ' ≈' : ''}</span>}<span className="muted">{placements(entry).length ? placements(entry).length + '×' : 'Not used'}</span>{badge && <span className="source-badge warning" title={status?.problem}>{badge}</span>}
            {file?.linked && <span className="asset-linked" role="img" aria-label="Linked to original file" title="Linked to original file"><Icon name="link" size={16} /></span>}
          </span>
        </div></Fragment>;
      })}

      {!shown.length && <p className="asset-empty muted">{entries.length ? 'No matching assets' : 'No assets'}</p>}
    </div>
    <footer className="asset-status-bar">
      <span className="muted">{shown.length} of {entries.length}{chosen.length ? ' · ' + chosen.length + ' selected' : ''}</span>
      {missing > 0 && <button disabled={locked} onClick={() => void act({ action: 'locate-folder', keys: everyKey(({ key }) => unavailable(key)) })}>Locate Folder…</button>}
      {linked > 0 && <button disabled={locked || (chosen.length > 0 && !copyCount)} onClick={() => void act({ action: 'collect', keys: copyKeys })}>
        {chosen.length ? 'Copy ' + copyCount + ' Selected into Book' : 'Copy All ' + linked + ' into Book'}</button>}
    </footer>
    {error && <p role="alert" data-error-code={error.code} className="error-text">{error.message}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}

// Edits an asset's name in its row, as in Finder: the name without its extension is selected; Return or leaving the
// field renames, Escape keeps the name. Keys stay in the field, so Space or arrows do not act on the list.
function RenameField({ name, done }: { name: string; done: (name?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (value?: string) => { if (finished.current) return; finished.current = true; done(value); };
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    const dot = name.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, []);
  return <input ref={input} className="asset-rename" aria-label={'New name for ' + name} defaultValue={name} spellCheck={false}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget.value.trim() || undefined); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(); }
    }}
    onBlur={(event) => finish(event.currentTarget.value.trim() || undefined)} />;
}
