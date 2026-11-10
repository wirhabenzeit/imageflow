import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { renderOrigin } from './desktop';
import type { BoxLocation, Command, ImportRequest, Issue, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import { assignmentCounts, newSpread } from './editing';
import { Inspector } from './Inspector';
import type { BookCheck, Edit } from './Inspector';
import { pageSequence, resolveFormat } from './format';
import type { ProjectFiles } from './project';

type Rect = Omit<BoxLocation, 'id' | 'type'>;
type Geometry = { type: 'geometry'; sheet: Rect; boxes: (Omit<BoxLocation, 'type'> & { type: BoxLocation['type'] | 'element' })[] };
const photoMime = 'application/x-imageflow-photo';

function Guides({ geometry, template }: { geometry: Geometry; template: TemplateInfo }) {
  const { sheet } = geometry;
  const { trim, bleed, safe, spreadWidth, height } = resolveFormat(template.format);
  const x = sheet.width / spreadWidth;
  const y = sheet.height / height;
  return <div className="guides" aria-hidden="true">
    <div className="trim-guide" style={{ left: sheet.x + bleed.outside * x, top: sheet.y + bleed.top * y,
      width: trim.width * 2 * x, height: trim.height * y }} />
    <div className="gutter-guide" style={{ left: sheet.x + sheet.width / 2, top: sheet.y, height: sheet.height }} />
    {[0, 1].map((half) => <div className="safe-guide" key={half} style={{
      left: sheet.x + (bleed.outside + half * trim.width + (half ? safe.binding : safe.outside)) * x,
      top: sheet.y + (bleed.top + safe.top) * y,
      width: (trim.width - safe.binding - safe.outside) * x, height: (trim.height - safe.top - safe.bottom) * y,
    }} />)}
  </div>;
}

export function App() {
  const api = window.imageflow;
  const [summary, setSummary] = useState<ProjectSummary>();
  const current = useRef<ProjectSummary>(undefined);
  const [spreadId, setSpreadId] = useState('');
  const [template, setTemplate] = useState<TemplateInfo>();
  const [render, setRender] = useState<RenderStatus>();
  const [geometry, setGeometry] = useState<Geometry>();
  const [showGuides, setShowGuides] = useState(false);
  const [highlight, setHighlight] = useState<string>();
  const [dropHighlight, setDropHighlight] = useState<string>();
  const [photo, setPhoto] = useState<string>();
  const [busy, setBusy] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const preview = useRef<HTMLIFrameElement>(null);
  // The book check renders the whole book in a hidden frame after the preview is ready, once per project revision.
  const checkFrame = useRef<HTMLIFrameElement>(null);
  const [checkId, setCheckId] = useState<string>();
  const [check, setCheck] = useState<BookCheck>();
  const queue = useRef(Promise.resolve());
  const history = useRef<{ past: ProjectFiles[]; future: ProjectFiles[] }>({ past: [], future: [] });
  const spreads = summary?.project.spreads ?? [];
  const index = Math.max(0, spreads.findIndex(({ id }) => id === spreadId));
  const spread = spreads[index];
  const sequence = template && pageSequence(spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const writable = !!summary && !summary.readOnly;

  function adopt(next: ProjectSummary, reset = false, selected?: string) {
    current.current = next;
    if (reset) {
      history.current = { past: [], future: [] };
      setTemplate(undefined);
      setPhoto(undefined);
    }
    setSpreadId((previous) => selected ?? (reset ? next.project.spreads[0].id :
      next.project.spreads.find(({ id }) => id === previous)?.id ?? next.project.spreads[0].id));
    setRender(undefined);
    setGeometry(undefined);
    setSummary(next);
  }

  function enqueue(task: () => Promise<void>) {
    queue.current = queue.current.then(async () => {
      setError('');
      setNotice('');
      try {
        await task();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'ImageFlow could not complete the request.');
      } finally {
        setBusy('');
        setExporting(false);
      }
    });
  }

  function edit(change: Edit, notice?: string, selected?: string) {
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly) return;
      const files = structuredClone({ project: before.project, photoIndex: before.photoIndex });
      change(files);
      if (template) files.project.template.version = template.version;
      if (JSON.stringify(files.project) === JSON.stringify(before.project) &&
          JSON.stringify(files.photoIndex) === JSON.stringify(before.photoIndex)) return;
      const result = await api.saveProject(before.id, files);
      if ('error' in result) throw new Error(result.error);
      history.current.past.push({ project: before.project, photoIndex: before.photoIndex });
      history.current.future = [];
      adopt(result.value, false, selected);
      setNotice(notice ?? 'Saved');
    });
  }

  function undo(direction: 'undo' | 'redo') {
    enqueue(async () => {
      const before = current.current;
      const [source, destination] = direction === 'undo'
        ? [history.current.past, history.current.future]
        : [history.current.future, history.current.past];
      const prior = source.at(-1);
      if (!api || !before || !prior || before.readOnly) return;
      const files = structuredClone(prior);
      files.project.texts = { ...before.project.texts, ...files.project.texts };
      files.photoIndex = { ...before.photoIndex, ...files.photoIndex };
      const result = await api.saveProject(before.id, files);
      if ('error' in result) throw new Error(result.error);
      source.pop();
      destination.push({ project: before.project, photoIndex: before.photoIndex });
      adopt(result.value);
      setNotice(direction === 'undo' ? 'Edit undone' : 'Edit redone');
    });
  }

  function importFiles(request: ImportRequest) {
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly) return;
      setBusy('Importing files…');
      const result = await api.importFiles(before.id, request);
      if ('error' in result) throw new Error(result.error);
      if (!result.value) return;
      if (request.target) {
        history.current.past.push({ project: before.project, photoIndex: before.photoIndex });
        history.current.future = [];
      }
      adopt(result.value.summary);
      if (request.kind === 'photo') setPhoto(result.value.imported[0]);
      setNotice('Imported ' + result.value.imported.length + (result.value.imported.length === 1 ? ' file' : ' files'));
    });
  }

  function act(command: Command) {
    if (command === 'undo' || command === 'redo') return undo(command);
    if (command === 'import-photos' || command === 'import-folder' || command === 'import-texts') {
      return importFiles({ kind: command === 'import-texts' ? 'markdown' : 'photo', folder: command === 'import-folder' });
    }
    enqueue(async () => {
      if (!api) return;
      const before = current.current;
      if (command === 'export' || command === 'print') {
        if (!before) return;
        setBusy('Preparing export…');
        setExporting(true);
        const result = await api.exportBook(before.id, command === 'print' ? 'print' : 'proof');
        if ('error' in result) throw new Error(result.error);
        if (!result.value) return;
        const count = result.value.warnings.length;
        setNotice((command === 'print' ? 'Print PDF saved.' : 'Proof PDF saved.') +
          (count ? ' ' + count + (count === 1 ? ' warning' : ' warnings') + ' in Book check.' : ''));
        if (before.id === current.current?.id) setCheck({ id: before.id, errors: [], warnings: result.value.warnings });
        return;
      }
      setBusy(command === 'new' ? 'Creating project…' : 'Opening project…');
      const result = await api.openProject(command);
      if ('error' in result) throw new Error(result.error);
      if (result.value) adopt(result.value, command !== 'reload');
    });
  }

  const onCommand = useEffectEvent((command: Command) => { if (!busy) act(command); });
  useEffect(() => {
    if (!api) return;
    const command = api.onCommand((command) => onCommand(command));
    const changed = api.onProjectChanged((result) => {
      if ('error' in result) setError(result.error);
      else {
        adopt(result.value);
        setError('');
        setNotice('Project files reloaded');
      }
    });
    const progress = api.onProgress(setBusy);
    return () => { command(); changed(); progress(); };
  }, [api]);

  useEffect(() => {
    function receive(event: MessageEvent<RenderStatus | Geometry>) {
      if (event.origin !== renderOrigin || !event.data) return;
      const checked = checkFrame.current;
      if (checked && event.source === checked.contentWindow && 'state' in event.data) {
        const id = checked.dataset.project!;
        setCheck(event.data.state === 'ready' ? { id, errors: event.data.errors, warnings: event.data.warnings } :
          { id, errors: [{ message: event.data.message }], warnings: [] });
        return;
      }
      if (event.source !== preview.current?.contentWindow) return;
      if ('type' in event.data && event.data.type === 'geometry') setGeometry(event.data);
      else if ('state' in event.data) {
        setRender(event.data);
        if (event.data.template) setTemplate(event.data.template);
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (summary && render && checkId !== summary.id) setCheckId(summary.id);
  }, [summary, render, checkId]);
  const checkCurrent = !!check && check.id === summary?.id;
  const spreadIssues = new Map<string, 'error' | 'warning'>();
  for (const [level, list] of [['warning', check?.warnings ?? []], ['error', check?.errors ?? []]] as const) {
    for (const { spread } of list as Issue[]) if (spread) spreadIssues.set(spread, level);
  }

  function move(offset: number) {
    if (!spread) return;
    edit(({ project }) => {
      const start = project.spreads.findIndex(({ id }) => id === spread.id);
      const end = start + offset;
      if (start < 0 || end < 0 || end >= project.spreads.length) return;
      const [item] = project.spreads.splice(start, 1);
      project.spreads.splice(end, 0, item);
    });
  }

  function add(duplicate = false) {
    if (!template || !spread) return;
    const entry = Object.entries(template.spreads).find(([, value]) => value.span === 'spread');
    if (!entry && !duplicate) return;
    const next = duplicate ? { ...structuredClone(spread), id: crypto.randomUUID() } : newSpread(entry![0]);
    edit(({ project }) => {
      const position = project.spreads.findIndex(({ id }) => id === spread.id);
      const insert = template.spreads[spread.definition]?.span === 'left' ? position : position + 1;
      project.spreads.splice(insert, 0, next);
    }, undefined, next.id);
  }

  function target(event: DragEvent<HTMLElement>) {
    const canvas = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - canvas.left;
    const y = event.clientY - canvas.top;
    return geometry?.boxes.findLast((box) => box.type !== 'element' && x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height);
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropHighlight(undefined);
    if (!api || !writable || !spread || busy) return;
    const box = target(event);
    const photoId = event.dataTransfer.getData(photoMime);
    if (photoId && box?.type === 'photo' && summary?.photoIndex[photoId]) {
      edit(({ project }) => {
        const state = project.spreads.find(({ id }) => id === spread.id);
        if (state) state.boxes[box.id] = { photo: photoId, params: state.boxes[box.id]?.params ?? {} };
      });
      return;
    }
    const paths = api.pathsForFiles([...event.dataTransfer.files]);
    if (!paths.length) return;
    const kind = box?.type === 'markdown' ? 'markdown' : box?.type === 'photo' ? 'photo' :
      paths.every((path) => /\.md$/i.test(path)) ? 'markdown' : 'photo';
    importFiles({ kind, paths, target: box ? { spread: spread.id, box: box.id } : undefined });
  }

  const activeBox = geometry?.boxes.find(({ id }) => id === (dropHighlight ?? highlight));
  const issue = error || (render?.state === 'error' ? render.message : '');
  const canExport = render?.state === 'ready' && !busy;
  const counts = summary ? assignmentCounts(summary.project) : {};
  const select = (id: string) => {
    if (id === spread?.id) return;
    setRender(undefined);
    setGeometry(undefined);
    setSpreadId(id);
  };

  return <div className="studio">
    <header className="toolbar">
      <div className="brand"><span className="brand-icon" aria-hidden="true">◫</span> ImageFlow</div>
      <div className="toolbar-actions">
        <button disabled={!api || !!busy} onClick={() => act('new')}>New project…</button>
        <button disabled={!api || !!busy} onClick={() => act('open')}>Open project…</button>
        <button disabled={!summary || !!busy} onClick={() => act('reload')}>Reload</button>
        <button disabled={!canExport} onClick={() => act('export')}>Export proof PDF</button>
        <button className="primary" disabled={!canExport} onClick={() => act('print')}>Export print PDF</button>
        {exporting && <button onClick={() => void api?.cancelExport()}>Cancel export</button>}
      </div>
    </header>
    <div className={summary ? 'workspace' : 'workspace welcome-workspace'}>
      <aside className="project-panel" aria-label="Project">
        <p className="eyebrow">Project</p>
        <h1>{summary?.project.title ?? 'Photobook studio'}</h1>
        <p className="muted">{summary ? summary.folder + (summary.readOnly ? ' · Sample' : '') : 'Local photobook projects'}</p>
        {!summary && <button className="sample-button" disabled={!api || !!busy} onClick={() => act('sample')}>Open sample project</button>}
        {summary && <>
          <div className="compact-actions history">
            <button disabled={!history.current.past.length || !!busy} onClick={() => undo('undo')}>Undo</button>
            <button disabled={!history.current.future.length || !!busy} onClick={() => undo('redo')}>Redo</button>
          </div>
          <p className="eyebrow section-label">Spreads</p>
          <div className="compact-actions">
            <button disabled={!writable || !template || !!busy} onClick={() => add()}>Add</button>
            <button disabled={!writable || !template || !!busy} onClick={() => add(true)}>Duplicate</button>
            <button disabled={!writable || spreads.length < 2 || !!busy} onClick={() => edit(({ project }) => {
              project.spreads = project.spreads.filter(({ id }) => id !== spread.id);
            })}>Delete</button>
          </div>
          <div className="compact-actions">
            <button aria-label="Move spread up" disabled={!writable || index === 0 || !!busy} onClick={() => move(-1)}>↑</button>
            <button aria-label="Move spread down" disabled={!writable || index === spreads.length - 1 || !!busy} onClick={() => move(1)}>↓</button>
          </div>
          <ol className="spread-list">
            {spreads.map(({ id, definition }, i) => {
              const pages = sequence?.spreads[i].page;
              const range = pages?.left && pages?.right ? pages.left + '–' + pages.right : pages?.left ?? pages?.right;
              const level = spreadIssues.get(id);
              return <li key={id}><button aria-current={index === i ? 'page' : undefined} disabled={!!busy} onClick={() => select(id)}>
                <span>{template?.spreads[definition]?.label ?? 'Spread ' + (i + 1)}</span>
                <span className="muted">{level && <span className={'issue-dot issue-' + level}
                  title={level === 'error' ? 'Has errors' : 'Has warnings'} aria-label={level === 'error' ? 'Has errors' : 'Has warnings'} />}{range}</span>
              </button></li>;
            })}
          </ol>
          {template && <div className="format">
            <p className="eyebrow">Print format</p>
            <p>{template.format.label}</p>
            <p className="muted">{sequence?.count} book pages</p>
          </div>}
        </>}
      </aside>
      <div className="workspace-center">
        <main className="canvas" aria-label="Spread preview" onDragOver={(event) => {
          if (!writable || !event.dataTransfer.types.some((type) => type === 'Files' || type === photoMime)) return;
          event.preventDefault();
          setDropHighlight(target(event)?.id);
        }} onDragLeave={() => setDropHighlight(undefined)} onDrop={drop}>
          {summary && <iframe key={summary.id + ':' + index} ref={preview} title={'Spread ' + (index + 1) + ' preview'}
            src={renderOrigin + '/render/' + summary.id + '?spread=' + index} />}
          {checkId && <iframe key={checkId} ref={checkFrame} className="book-check" data-project={checkId} title="Book check"
            aria-hidden="true" tabIndex={-1} src={renderOrigin + '/render/' + checkId + '?check'} />}
          {!summary && <div className="welcome">
            <span className="welcome-icon" aria-hidden="true">◫</span>
            <h2>See your book take shape</h2>
            <p>{api ? 'Create a book with the starter template, open a project you trust, or preview the Senja sample.' :
              'Launch the desktop app to open an ImageFlow project.'}</p>
            {api && <button className="primary" disabled={!!busy} onClick={() => act('sample')}>Try the Senja sample</button>}
          </div>}
          {geometry && showGuides && template && <Guides geometry={geometry} template={template} />}
          {activeBox && <div className="box-highlight" aria-hidden="true" style={{
            left: activeBox.x, top: activeBox.y, width: activeBox.width, height: activeBox.height,
          }} />}
          {summary && <label className="guides-toggle"><input type="checkbox" checked={showGuides}
            onChange={(event) => setShowGuides(event.target.checked)} /> Guides</label>}
          {summary && !render && <div className="preview-message" role="status">Rendering spread…</div>}
          {render?.state === 'error' && <div className="preview-message">Spread preview unavailable</div>}
        </main>
        {summary && <section className="filmstrip" aria-label="Photos" onDragOver={(event) => {
          if (writable && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }} onDrop={(event) => {
          event.preventDefault();
          if (!api || !writable || busy) return;
          const paths = api.pathsForFiles([...event.dataTransfer.files]);
          if (paths.length) importFiles({ kind: 'photo', paths });
        }}>
          <div className="filmstrip-bar">
            <span className="eyebrow">Photos · {Object.keys(summary.photoIndex).length}</span>
            <button disabled={!writable || !!busy} onClick={() => act('import-photos')}>Import photos…</button>
            <button disabled={!writable || !!busy} onClick={() => act('import-folder')}>Import folder…</button>
            <button disabled={!writable || !!busy} onClick={() => act('import-texts')}>Import Markdown…</button>
          </div>
          <div className="filmstrip-photos">
            {Object.entries(summary.photoIndex).map(([id, entry]) => {
              const title = entry.title || entry.path.split('/').pop() || id;
              return <button key={id} className="thumbnail" aria-pressed={photo === id} title={title} aria-label={title}
                draggable={writable && !!summary.photos[id]} onDragStart={(event) => {
                  event.dataTransfer.setData(photoMime, id);
                  event.dataTransfer.effectAllowed = 'copy';
                }} onClick={() => setPhoto(id)}>
                {summary.photos[id] ? <img src={summary.photos[id]} alt="" loading="lazy" /> : <span>Missing</span>}
                <span>{title}</span>{!!counts[id] && <small>{counts[id]}×</small>}
              </button>;
            })}
          </div>
        </section>}
      </div>
      {summary && spread && <Inspector summary={summary} spread={spread} template={template} render={render} photo={photo}
        edit={edit} highlight={setHighlight} issues={issue} check={check} checking={!checkCurrent} select={select}
        importText={(box) => importFiles({ kind: 'markdown', target: { spread: spread.id, box } })} />}
    </div>
    <footer className={issue ? 'status status-error' : 'status'} role={issue && !summary ? 'alert' : 'status'}>
      {issue || busy || notice || (summary ? 'Project preview · Proof export' : 'ImageFlow for macOS')}
    </footer>
  </div>;
}
