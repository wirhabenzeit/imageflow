import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import { bookLayout, renderOrigin } from './desktop';
import type { BookGeometry, Command, ImportRequest, Issue, ProjectChange, ProjectSummary, Rect, RenderStatus, TemplateInfo } from './desktop';
import { PanelDivider, usePanels } from './panels';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { BookFrame } from './BookFrame';
import { McpPanel } from './McpPanel';
import { revealIn } from './reveal';
import { EditPopover } from './EditPopover';
import { CropEditor } from './CropEditor';
import { ElementEditorDialog } from './ElementEditor';
import { PhotoContent, TextContent } from './BoxContent';
import { ProjectFilesContext } from './Fields';
import { centered, getCrop, placementIn, placementOf, setPlacement } from './spread';
import type { Placement } from './spread';
import { assignmentCounts, newSpread, readEdit, resolveEditPath, sourceUsage } from './editing';
import { moveContent, swapContent } from './layouts';
import { Fields } from './Fields';
import { Inspector } from './Inspector';
import type { Edit } from './Inspector';
import { BookCheckIndicator } from './BookCheck';
import type { BookCheck } from './BookCheck';
import { QuickLook, Sources } from './Sources';
import { keptMime, photoMime, sourceList, sourceTitle, textMime } from './source-items';
import type { SourceKind, SourceRef } from './source-items';
import { pageSequence, resolveFormat } from './format';
import type { ResolvedFormat } from './format';
import type { ProjectFiles, SpreadState } from './project';

type Owner = { type: 'photo' | 'markdown' | 'element'; id: string };
type InlineContext = {
  project: ProjectFiles['project']; spread: SpreadState; template: TemplateInfo; target: BookGeometry['targets'][number];
};

function inlineValues({ project, spread, template, target }: InlineContext) {
  return JSON.stringify([spread.definition, target.edits.map((path) => {
    const field = resolveEditPath(template, spread.definition, path);
    return [field, field && readEdit(project, spread, field)];
  })]);
}

// The editor shell must survive a template whose format cannot be resolved; the render reports why.
function formatOf(template?: TemplateInfo) {
  try {
    return template && resolveFormat(template.format);
  } catch {
    return undefined;
  }
}

function Guides({ sheet, format }: { sheet: Rect; format: ResolvedFormat }) {
  const { trim, bleed, safe, spreadWidth, height } = format;
  const x = sheet.width / spreadWidth;
  const y = sheet.height / height;
  return <div className="guides" aria-hidden="true" style={{ left: sheet.x, top: sheet.y, width: sheet.width, height: sheet.height }}>
    <div className="trim-guide" style={{ left: bleed.outside * x, top: bleed.top * y, width: trim.width * 2 * x, height: trim.height * y }} />
    <div className="gutter-guide" style={{ left: sheet.width / 2, top: 0, height: sheet.height }} />
    {[0, 1].map((half) => <div className="safe-guide" key={half} style={{
      left: (bleed.outside + half * trim.width + (half ? safe.binding : safe.outside)) * x,
      top: (bleed.top + safe.top) * y,
      width: (trim.width - safe.binding - safe.outside) * x, height: (trim.height - safe.top - safe.bottom) * y,
    }} />)}
  </div>;
}


export function App() {
  const api = window.imageflow;
  const { panels, toggle: togglePanel, resize: resizePanel } = usePanels();
  const [resizing, setResizing] = useState(false);
  const [summary, setSummary] = useState<ProjectSummary>();
  const [projectInstance, setProjectInstance] = useState(0);
  const current = useRef<ProjectSummary>(undefined);
  const [spreadId, setSpreadId] = useState('');
  const [template, setTemplate] = useState<TemplateInfo>();
  const [render, setRender] = useState<RenderStatus>();
  const [reload, setReload] = useState<'loading' | 'rendering' | { error: string }>();
  const reloading = useRef(false);
  // A reload that finished with an error is settled: the agent may commit a repair, while human edits stay disabled.
  const reloadFailed = useRef(false);
  const inputGeneration = useRef(0);
  const candidateId = useRef<string>(undefined);
  const readyId = useRef<string>(undefined);
  // The last finished render. The Inspector keeps showing its flow positions while an edit re-renders, so lines
  // like "Flow 1 of 2" do not vanish for a moment and shift the panel.
  const [lastReady, setLastReady] = useState<RenderStatus>();
  const [geometry, setGeometry] = useState<BookGeometry>();
  const [thumbs, setThumbs] = useState<BookGeometry>();
  const [inView, setInView] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string>();
  const [hoveredTarget, setHoveredTarget] = useState<string>();
  // The inline editor that is open: for a marked node (a target), or for a box or element itself (`owner`).
  const [editing, setEditing] = useState<{ spread: string; key: string; held?: InlineContext; owner?: Owner }>();
  // Crop mode for one photo box. After a commit, `settling` holds the project id the edit started from; the
  // overlay stays until the book has re-rendered, so the frame does not flash back to the old crop.
  // The selected photo, whose crop drags and pinches adjust. `layout` is the spread's layout when it was selected:
  // each layout has its own crop. `saved` holds the project id the last crop edit started from; after the photo is
  // deselected, `settling` keeps its overlay until the book has re-rendered, so the frame does not flash back.
  const [cropping, setCropping] = useState<{ spread: string; box: string; layout: string; saved?: string; settling?: string }>();
  // A template-supplied element editor that is open.
  const [elementEditor, setElementEditor] = useState<{ spread: string; element: string }>();
  const [showGuides, setShowGuides] = useState(false);
  const [highlight, setHighlight] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [sourceTab, setSourceTab] = useState<SourceKind>('photo');
  // Selection is exclusive: a source from the strip, or else the current spread.
  const [selectedSource, setSelectedSource] = useState<SourceRef>();
  const [focusBox, setFocusBox] = useState<{ box: string; at: number }>();
  const [quick, setQuick] = useState<SourceRef>();
  const [busy, setBusy] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [check, setCheck] = useState<BookCheck>();
  const canvas = useRef<HTMLElement>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const thumbList = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string>(undefined);
  const queue = useRef(Promise.resolve());
  const agentLocked = useRef(false);
  const [agentWorking, setAgentWorking] = useState(false);
  const pendingTasks = useRef(0);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api?.setPanelVisibility({ sidebar: !panels.leftHidden, inspector: !panels.rightHidden });
  }, [api, panels.leftHidden, panels.rightHidden]);
  const spreads = summary?.project.spreads ?? [];
  const index = Math.max(0, spreads.findIndex(({ id }) => id === spreadId));
  const spread = spreads[index];
  const sequence = template && pageSequence(spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const pageLabels = spreads.map((_, i) => {
    const pages = sequence?.spreads[i]?.page;
    return pages?.left && pages?.right ? pages.left + '–' + pages.right : String(pages?.left ?? pages?.right ?? '');
  });
  const writable = !!summary && !summary.readOnly && !reload && !agentWorking;
  const canvasReady = render?.state === 'ready' && !reload;
  const holdPreview = reload === 'loading' || typeof reload === 'object';
  const generation = inputGeneration.current;

  function clearCanvasEditors() {
    setCropping(undefined);
    setHovered(undefined);
    setHoveredTarget(undefined);
    setDropTarget(undefined);
    setHighlight(undefined);
    setFocusBox(undefined);
    pendingMove.current = undefined;
    setMoving(undefined);
  }

  function beginReload() {
    inputGeneration.current++;
    reloading.current = true;
    reloadFailed.current = false;
    candidateId.current = undefined;
    readyId.current = undefined;
    holdInlineEditor();
    clearCanvasEditors();
    setRender(undefined);
    setReload('loading');
  }

  function adoptReload(next: ProjectSummary) {
    adopt(next);
    reloadFailed.current = false;
    setReload('rendering');
  }

  function failReload(message: string) {
    reloadFailed.current = true;
    setReload({ error: message });
  }

  function adopt(next: ProjectSummary, reset = false, selected?: string) {
    current.current = next;
    candidateId.current = next.id;
    readyId.current = undefined;
    if (reset) {
      inputGeneration.current++;
      reloading.current = false;
      reloadFailed.current = false;
      setTemplate(undefined);
      setSelectedSource(undefined);
      setQuick(undefined);
      setLastReady(undefined);
      setEditing(undefined);
      setElementEditor(undefined);
      setGeometry(undefined);
      setThumbs(undefined);
      setCheck(undefined);
      setReload(undefined);
      setProjectInstance((previous) => previous + 1);
      clearCanvasEditors();
      pendingReveal.current = undefined;
      revealedThumb.current = '';
      canvas.current?.scrollTo({ top: 0 });
    }
    setSpreadId((previous) => selected ?? (reset ? next.project.spreads[0].id :
      next.project.spreads.find(({ id }) => id === previous)?.id ?? next.project.spreads[0].id));
    if (selected) pendingReveal.current = selected;
    setRender(undefined);
    setSummary(next);
  }

  function enqueue(task: () => Promise<void>) {
    pendingTasks.current++;
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
        pendingTasks.current--;
      }
    });
  }

  // `notice` may be a function, read after the change ran, for notices that describe what the change found.
  function edit(change: Edit, notice?: string | (() => string), selected?: string, canvasId?: string) {
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
          (canvasId && (before.id !== canvasId || readyId.current !== canvasId))) return;
      const files = structuredClone({ project: before.project, photoIndex: before.photoIndex });
      change(files);
      if (template) files.project.template.version = template.version;
      if (JSON.stringify(files.project) === JSON.stringify(before.project) &&
          JSON.stringify(files.photoIndex) === JSON.stringify(before.photoIndex)) return;
      const label = (typeof notice === 'function' ? notice() : notice) ?? 'Project edit';
      const result = await api.saveProject(before.id, files, label);
      if ('error' in result) throw new Error(result.error);
      if (current.current !== before) return;
      adopt(result.value, false, selected);
      setNotice((typeof notice === 'function' ? notice() : notice) ?? 'Saved');
    });
  }

  function editCanvas(change: Edit, notice?: string | (() => string)) {
    if (summary && readyId.current === summary.id) edit(change, notice, undefined, summary.id);
  }

  function undo(direction: 'undo' | 'redo') {
    const generation = inputGeneration.current;
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current) return;
      const result = await api.history(before.id, direction);
      if ('error' in result) throw new Error(result.error);
      if (current.current !== before) return;
      adopt(result.value);
      setNotice(direction === 'undo' ? 'Edit undone' : 'Edit redone');
    });
  }

  function importFiles(request: ImportRequest, canvasId?: string) {
    const generation = inputGeneration.current;
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
          (canvasId && (before.id !== canvasId || readyId.current !== canvasId))) return;
      setBusy('Importing files…');
      const result = await api.importFiles(before.id, request);
      if ('error' in result) throw new Error(result.error);
      if (!result.value || current.current !== before) return;
      adopt(result.value.summary);
      // Imports into the library select the first new source; imports onto a box keep the spread selected.
      if (!request.target) {
        const kind = request.kind === 'photo' ? 'photo' : 'text';
        setSourceTab(kind);
        setSelectedSource({ kind, id: result.value.imported[0] });
      }
      setNotice('Imported ' + result.value.imported.length + (result.value.imported.length === 1 ? ' file' : ' files'));
    });
  }

  // Adds a file for a file parameter to the project's registry and resolves to its ID; the caller assigns it as
  // a normal edit, so Undo removes the assignment and keeps the file.
  function importParameterFile(accept: string[]) {
    return importProjectFile(accept).then((imported) => imported?.id);
  }
  // The same, also naming the render session that has the new file, for an element editor frame to read it from.
  function importProjectFile(accept: string[]) {
    const generation = inputGeneration.current;
    return new Promise<{ id: string; project: string } | undefined>((resolve) => enqueue(async () => {
      try {
        const before = current.current;
        if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current) return resolve(undefined);
        setBusy('Importing file…');
        const result = await api.importFiles(before.id, { kind: 'file', accept });
        if ('error' in result) throw new Error(result.error);
        if (!result.value || current.current !== before) return resolve(undefined);
        adopt(result.value.summary);
        const [id] = result.value.imported;
        resolve(id ? { id, project: result.value.summary.id } : undefined);
      } catch (error) {
        resolve(undefined);
        throw error;
      }
    }));
  }
  // importParameterFile only reads refs, the preload API and state setters, so it may be kept from the first render.
  const projectFiles = useMemo(() => ({ files: summary?.project.files ?? {}, importFile: importParameterFile }), [summary?.project.files]);

  function act(command: Command) {
    if (command === 'agent-settings') return;
    if (command === 'toggle-project' || command === 'toggle-inspector') {
      togglePanel(command === 'toggle-project' ? 'left' : 'right');
      return;
    }
    if (command === 'undo' || command === 'redo') return undo(command);
    if (command === 'import-photos' || command === 'import-folder' || command === 'import-texts') {
      return importFiles({ kind: command === 'import-texts' ? 'markdown' : 'photo', folder: command === 'import-folder' });
    }
    enqueue(async () => {
      if (!api || agentLocked.current) return;
      const before = current.current;
      if (command === 'export' || command === 'print') {
        if (!before || readyId.current !== before.id) return;
        setBusy('Preparing export…');
        setExporting(true);
        const result = await api.exportBook(before.id, command === 'print' ? 'print' : 'proof');
        if ('error' in result) throw new Error(result.error);
        if (!result.value) return;
        // The export rendered the whole book; its result is the complete Book check for that project state.
        const { errors, warnings } = result.value;
        const counted = (n: number, word: string) => n ? n + ' ' + word + (n === 1 ? '' : 's') : '';
        const found = [counted(errors.length, 'error'), counted(warnings.length, 'warning')].filter(Boolean).join(', ');
        setNotice((command === 'print' ? 'Print PDF saved.' : 'Proof PDF saved.') + (found ? ' ' + found + ' in Book check.' : ''));
        if (before.id === current.current?.id) setCheck({ id: before.id, errors, warnings });
        return;
      }
      if (command === 'reload') {
        if (!before) return;
        beginReload();
        const generation = inputGeneration.current;
        try {
          const result = await api.openProject(command);
          if (generation !== inputGeneration.current || current.current !== before) return;
          if ('error' in result) failReload(result.error);
          else if (result.value) adoptReload(result.value);
          else failReload('Could not reload the project.');
        } catch (error) {
          if (generation === inputGeneration.current && current.current === before) {
            failReload(error instanceof Error ? error.message : 'Could not reload the project.');
          }
        }
        return;
      }
      setBusy(command === 'new' ? 'Creating project…' : 'Opening project…');
      const result = await api.openProject(command);
      if ('error' in result) throw new Error(result.error);
      if (result.value) adopt(result.value, true);
    });
  }

  const onCommand = useEffectEvent((command: Command) => { if (command.startsWith('toggle-') || (!busy && !agentLocked.current)) act(command); });
  const onProjectChanged = useEffectEvent((change: ProjectChange) => {
    if ('building' in change) beginReload();
    else if ('error' in change) {
      if (!reloading.current) beginReload();
      failReload(change.error);
    } else {
      if (!reloading.current) beginReload();
      adoptReload(change.value);
      setError('');
    }
  });
  const acquireAgentLease = useEffectEvent(() => {
    const focused = document.activeElement;
    const typing = focused instanceof HTMLElement && (focused.matches('input, textarea, select, [contenteditable="true"]') || !!focused.closest('dialog'));
    const reloadRunning = reloading.current && !reloadFailed.current;
    if (pendingTasks.current || busy || reloadRunning || editing || elementEditor || cropping || typing || agentLocked.current) return false;
    agentLocked.current = true;
    if (workspace.current) workspace.current.inert = true;
    setAgentWorking(true);
    return true;
  });
  useEffect(() => {
    if (!api) return;
    const lease = api.onAgentLease(() => acquireAgentLease());
    const release = api.onAgentRelease(() => {
      agentLocked.current = false;
      if (workspace.current) workspace.current.inert = false;
      setAgentWorking(false);
    });
    const command = api.onCommand((command) => onCommand(command));
    const changed = api.onProjectChanged((change) => onProjectChanged(change));
    const progress = api.onProgress(setBusy);
    // In dev mode a full page reload or main-process restart would drop the open project; reopen it.
    if (import.meta.env.DEV) {
      void api.openProject('reload').then((result) => { if ('value' in result && result.value) adopt(result.value, true); });
    }
    return () => { command(); changed(); progress(); lease(); release(); };
  }, [api]);

  // The book frame renders every spread, so its status doubles as the book check.
  const acceptCandidate = (id: string) => candidateId.current === id;
  function bookStatus(status: RenderStatus, id: string) {
    if (!acceptCandidate(id)) return;
    setRender(status);
    if (status.state === 'ready') {
      readyId.current = id;
      if (reloading.current) setNotice('Project files reloaded');
      reloading.current = false;
      reloadFailed.current = false;
      setReload(undefined);
      setLastReady(status);
      setTemplate(status.template);
      setCropping((previous) => previous?.settling && previous.settling !== id ? undefined : previous);
    } else {
      candidateId.current = undefined;
      readyId.current = undefined;
      if (reloading.current) failReload(status.message);
      else inputGeneration.current++;
      holdInlineEditor();
      clearCanvasEditors();
    }
    setCheck(status.state === 'ready' ? { id, errors: status.errors, warnings: status.warnings } :
      { id, errors: [{ message: status.message }], warnings: [] });
  }
  const checkCurrent = !!check && check.id === summary?.id;
  const spreadIssues = new Map<string, 'error' | 'warning'>();
  for (const [level, list] of [['warning', check?.warnings ?? []], ['error', check?.errors ?? []]] as const) {
    for (const { spread } of list as Issue[]) if (spread) spreadIssues.set(spread, level);
  }

  // Scrolls the book so a spread is fully visible. Waits for the next layout if the spread is new.
  function reveal(id: string) {
    const sheet = geometry?.sheets.find(({ spread }) => spread === id);
    const view = canvas.current;
    if (!sheet || !view || !stage.current) {
      pendingReveal.current = id;
      return;
    }
    pendingReveal.current = undefined;
    const top = stage.current.offsetTop + sheet.y;
    const label = bookLayout.book.gap;
    if (top - label >= view.scrollTop && top + sheet.height <= view.scrollTop + view.clientHeight) return;
    view.scrollTo({ top: Math.max(0, top - Math.max(label, (view.clientHeight - sheet.height) / 2)), behavior: 'smooth' });
  }
  // The part of the book frame that is on screen, in frame coordinates. The book frame loads photos near it.
  function viewport() {
    const view = canvas.current;
    if (!view || !stage.current) return undefined;
    const top = view.scrollTop - stage.current.offsetTop;
    return { top, bottom: top + view.clientHeight };
  }
  function measureView() {
    const view = canvas.current;
    const range = viewport();
    if (range) {
      for (const frame of stage.current!.querySelectorAll<HTMLIFrameElement>('iframe.book-frame-book')) {
        frame.contentWindow?.postMessage({ type: 'viewport', ...range }, renderOrigin);
      }
    }
    if (!view || !stage.current || !geometry) return;
    const top = view.scrollTop - stage.current.offsetTop;
    const bottom = top + view.clientHeight;
    const ids = geometry.sheets.filter(({ y, height }) => y < bottom && y + height > top).map(({ spread }) => spread);
    setInView((previous) => previous.join() === ids.join() ? previous : ids);
  }
  useEffect(() => {
    measureView();
    if (pendingReveal.current) reveal(pendingReveal.current);
  }, [geometry]);
  const onResize = useEffectEvent(() => measureView());
  useEffect(() => {
    const listener = () => onResize();
    window.addEventListener('resize', listener);
    const observer = new ResizeObserver(listener);
    if (canvas.current) observer.observe(canvas.current);
    return () => { window.removeEventListener('resize', listener); observer.disconnect(); };
  }, [projectInstance]);
  // The sidebar follows the selection when you select another spread, not on every re-render after an edit,
  // so a list you scrolled elsewhere stays where you left it.
  const revealedThumb = useRef('');
  useEffect(() => {
    if (!spreadId || revealedThumb.current === spreadId || !thumbs) return;
    const button = thumbList.current?.querySelector<HTMLElement>('[data-spread="' + CSS.escape(spreadId) + '"]');
    const list = thumbList.current?.parentElement;
    if (!button || !list) return;
    revealIn(list, button);
    revealedThumb.current = spreadId;
  }, [spreadId, thumbs]);

  function select(id: string, scroll = true) {
    setSpreadId(id);
    setSelectedSource(undefined);
    if (scroll) reveal(id);
  }

  function move(offset: number) {
    if (!spread) return;
    pendingReveal.current = spread.id;
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

  function assign(spread: string, box: string, source: SourceRef) {
    editCanvas(({ project }) => {
      const state = project.spreads.find(({ id }) => id === spread);
      if (state) state.boxes[box] = { params: state.boxes[box]?.params ?? {}, ...(source.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
    });
  }

  // Moves content a spread keeps outside its layout into one of its boxes; content already there is kept instead.
  function place(spread: string, from: string, to: string, fromCanvas = false) {
    if (!summary || !template) return;
    const state = spreads.find(({ id }) => id === spread);
    const moving = state?.boxes[from];
    const label = state && template.spreads[state.definition]?.boxes[to]?.label;
    if (!moving || !label) return;
    const kind = moving.photo ? 'photo' : 'text';
    let swapped: string | undefined;
    const apply = fromCanvas ? editCanvas : edit;
    apply(({ project }) => {
      const current = project.spreads.find(({ id }) => id === spread);
      if (current) swapped = moveContent(current, from, to);
    }, () => sourceTitle(summary, kind, (moving.photo ?? moving.text)!) + ' placed in ' + label +
      (swapped ? '; ' + sourceTitle(summary, kind, swapped) + ' is saved outside this layout' : ''));
    // The Inspector scrolls to the box that received it.
    setFocusBox({ box: to, at: Date.now() });
  }

  // Finds the spread and box under a pointer. The label strip above each spread belongs to the spread.
  function locate(event: { clientX: number; clientY: number }, types?: readonly string[]) {
    const bounds = stage.current?.getBoundingClientRect();
    if (!bounds || !geometry) return {};
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const inside = (rect: Rect, above = 0) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y - above && y <= rect.y + rect.height;
    const sheet = geometry.sheets.find((rect) => inside(rect, bookLayout.book.gap))?.spread;
    if (readyId.current !== summary?.id) return { sheet };
    const wanted = types?.includes(photoMime) ? 'photo' : types?.includes(textMime) ? 'markdown' : undefined;
    const box = geometry.boxes.findLast((rect) => rect.type !== 'element' && (!wanted || rect.type === wanted) && inside(rect));
    // The smallest edit target under the pointer wins, unless a smaller box sits on top of it.
    const area = (rect: Rect) => rect.width * rect.height;
    const target = wanted ? undefined : geometry.targets.filter((rect) => inside(rect))
      .sort((a, b) => area(a) - area(b))[0];
    const element = wanted ? undefined : geometry.boxes.findLast((rect) => rect.type === 'element' && inside(rect));
    // The box or element drawn on top: geometry lists them in document order, so a later one covers an earlier
    // one (an inset map over a full-bleed photo). Templates that reorder with z-index are not accounted for.
    const top = wanted ? box : geometry.boxes.findLast((rect) => inside(rect));
    return { sheet, box, element, top, target: target && (!box || area(target) <= area(box)) ? target : undefined };
  }
  const targetKey = (target: { spread: string; edits: string[] }) => target.spread + '|' + target.edits.join(' ');
  const closeEditor = useCallback(() => setEditing(undefined), []);
  // Tab moves between the edit targets of a spread in reading order.
  function stepEditor(direction: 1 | -1) {
    if (!editing || !geometry || readyId.current !== summary?.id) return;
    const order = geometry.targets.filter(({ spread }) => spread === editing.spread)
      .sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
    const at = order.findIndex((target) => targetKey(target) === editing.key);
    const next = order[(at + direction + order.length) % order.length];
    setEditing(next ? { spread: next.spread, key: targetKey(next) } : undefined);
  }
  // A box or element is edited through the node it renders: its own target when it has parameters or marks (its
  // rectangle is the box's), else its rectangle with nothing marked, for the platform's part of the editor.
  function ownerTarget(spread: string, id: string) {
    const rect = geometry?.boxes.find((box) => box.spread === spread && box.id === id);
    if (!rect) return undefined;
    const same = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
    return geometry?.targets.find((target) => target.spread === spread && same(target, rect)) ?? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, spread, edits: [] };
  }
  const ownerKey = (spread: string, id: string) => spread + '|#' + id;
  const editTarget = editing && (editing.owner ? ownerTarget(editing.spread, editing.owner.id)
    : geometry?.targets.find((target) => targetKey(target) === editing.key));
  const editSpread = editing && spreads.find(({ id }) => id === editing.spread);
  const liveInline = summary && template && editSpread && editTarget &&
    { project: summary.project, spread: editSpread, template, target: editTarget };
  const resumeInline = !!(canvasReady && editing?.held && liveInline && inlineValues(liveInline) === inlineValues(editing.held));
  const inline = resumeInline ? liveInline : editing?.held ?? liveInline;
  function holdInlineEditor() {
    if (editing && !editing.held && liveInline) setEditing({ ...editing, held: liveInline });
  }
  useEffect(() => {
    if (resumeInline && readyId.current === summary?.id) setEditing((open) => open && { ...open, held: undefined });
  }, [resumeInline, summary?.id]);

  // Flow positions of the last finished render, kept while an edit re-renders so "Flow 1 of 2" does not flicker.
  const readyFlow = render?.state === 'ready' ? render.flow : lastReady?.state === 'ready' ? lastReady.flow : undefined;
  // Edits one spread, if it still exists when the edit applies.
  function changeSpreadAt(id: string, update: (spread: SpreadState) => void, notice?: string) {
    edit(({ project }) => {
      const state = project.spreads.find((item) => item.id === id);
      if (state) update(state);
    }, notice);
  }
  // The same for the spread an inline editor is open on, and only while it shows the layout it opened in.
  function changeSpreadInline(update: (spread: SpreadState) => void, notice?: string) {
    editInline(({ project }) => {
      const state = project.spreads.find((item) => item.id === liveInline?.spread.id);
      if (state) update(state);
    }, notice);
  }
  function ownerLabel(spread: SpreadState, owner: Owner) {
    const layout = template?.spreads[spread.definition];
    return (owner.type === 'element' ? layout?.elements[owner.id]?.label : layout?.boxes[owner.id]?.label) ?? owner.id;
  }

  function editInline(change: Edit, notice?: string) {
    if (!liveInline || (editing?.held && !resumeInline)) return;
    edit((files) => {
      const active = files.project.spreads.find(({ id }) => id === liveInline.spread.id);
      if (active?.definition === liveInline.spread.definition) change(files);
    }, notice);
  }
  const editOwner = editTarget && /^boxes\.([^.]+)\./.exec(editTarget.edits[0])?.[1];
  const editElement = editTarget?.edits.map((path) => /^elements\.([^.]+)\./.exec(path)?.[1]).find(Boolean);
  const editPhotoBox = editOwner && geometry?.boxes.some(({ spread, id, type }) => spread === editing.spread && id === editOwner && type === 'photo')
    ? editOwner : undefined;

  // Crop mode: the frame comes from the rendered book, the photo size and crop from the project.
  const cropFrame = cropping && geometry?.boxes.find(({ spread, id }) => spread === cropping.spread && id === cropping.box);
  const cropSheet = cropping && geometry?.sheets.find(({ spread }) => spread === cropping.spread);
  const cropState = cropping && spreads.find(({ id }) => id === cropping.spread)?.boxes[cropping.box];
  const cropPhoto = cropState?.photo;
  const cropPlacement = cropping && placementIn(cropState, cropping.layout);
  const cropBox = cropping && template?.spreads[cropping.layout]?.boxes[cropping.box];
  function cropBlocked(spread: string, box: string) {
    if (readyId.current !== summary?.id) return 'The book preview is updating.';
    const state = spreads.find(({ id }) => id === spread)?.boxes[box];
    const frame = geometry?.boxes.find((rect) => rect.spread === spread && rect.id === box);
    if (!state?.photo || !summary?.photos[state.photo] || !summary.photoSizes[state.photo]) return 'Add a photo to this box first.';
    if (!frame) return 'The book is still rendering.';
    if (!frame.upright) return 'The template rotates or mirrors this frame; use its crop values.';
  }
  // Opens the editor of a box or element where it is on the page. A placed photo is selected to drag and pinch,
  // with its other settings in the crop toolbar; an element with its own editor opens that; anything else opens its
  // popover. The sidebar's list of a spread's boxes and elements opens the same editors, also for empty ones.
  function openOwner(spread: string, owner: Owner) {
    if (readyId.current !== summary?.id) {
      setNotice('The book preview is updating; try again in a moment.');
      return;
    }
    if (owner.type === 'photo') {
      const blocked = cropBlocked(spread, owner.id);
      if (!blocked) {
        startCrop(spread, owner.id);
        return;
      }
      // A placed photo that cannot be selected says why; its popover offers the crop as numbers.
      if (boxSource(spread, owner.id)) setNotice(blocked);
    }
    if (owner.type === 'element' && openElementEditor(spread, owner.id)) return;
    deselectPhoto();
    select(spread, false);
    setEditing({ spread, key: ownerKey(spread, owner.id), owner });
  }
  function editorOf(spread: string, element: string) {
    const state = spreads.find(({ id }) => id === spread);
    return state && template?.spreads[state.definition]?.elements[element]?.editor;
  }
  function openElementEditor(spread: string, element: string) {
    if (readyId.current !== summary?.id || !editorOf(spread, element)) return false;
    setEditing(undefined);
    select(spread, false);
    setElementEditor({ spread, element });
    return true;
  }
  function startCrop(spread: string, box: string) {
    const blocked = cropBlocked(spread, box);
    if (blocked) {
      setNotice(blocked);
      return false;
    }
    const layout = spreads.find(({ id }) => id === spread)?.definition;
    if (!layout) return false;
    setEditing(undefined);
    select(spread, false);
    setCropping({ spread, box, layout });
    return true;
  }
  // Saves the selected photo's crop; the photo stays selected. The edit compares with the project when it applies,
  // so an unchanged crop saves nothing.
  function saveCrop(placement: Placement) {
    if (!cropping || cropping.settling || !cropFrame || !cropPhoto || !summary || reloading.current ||
        generation !== inputGeneration.current) return;
    const size = summary.photoSizes[cropPhoto];
    const aspect = cropFrame.width / cropFrame.height;
    const normal = (value: Placement) => JSON.stringify(placementOf(getCrop(size, value, aspect), value.zoom));
    const fits = normal(placement) === normal(centered);
    const { spread, box, layout } = cropping;
    edit(({ project }) => {
      const state = project.spreads.find(({ id }) => id === spread);
      const target = state?.boxes[box];
      // Repeated crop edits can queue while an earlier crop renders. Check that this is still the same photo and layout.
      if (target?.photo !== cropPhoto || state?.definition !== layout) return;
      setPlacement(target, layout, fits ? centered : placement);
    }, 'Crop updated');
    setCropping({ ...cropping, saved: summary.id });
  }
  function deselectPhoto() {
    setCropping((selection) => {
      if (!selection || selection.settling) return selection;
      // Keep the overlay until the book shows the last saved crop.
      const waiting = selection.saved && (selection.saved === current.current?.id || render?.state !== 'ready');
      return waiting ? { ...selection, settling: selection.saved } : undefined;
    });
  }
  // If the save fails, there is no re-render to wait for.
  useEffect(() => {
    if (!cropping?.settling) return;
    const timer = setTimeout(() => setCropping(undefined), 4000);
    return () => clearTimeout(timer);
  }, [cropping?.settling]);

  // Moving a placed photo: press an unselected photo and drag it onto another photo box, on this spread or another.
  // The two swap; onto an empty box it moves. Its crops were made for the old frame and stay behind.
  const pendingMove = useRef<{ spread: string; box: string; photo: string; x: number; y: number }>(undefined);
  const moved = useRef(false);
  const [moving, setMoving] = useState<{ photo: string; x: number; y: number }>();
  const moveDrag = useEffectEvent((event: PointerEvent) => {
    const start = pendingMove.current;
    if (!start || readyId.current !== summary?.id) return;
    if (!moving && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
    setMoving({ photo: start.photo, x: event.clientX, y: event.clientY });
    const { box } = locate(event, [photoMime]);
    setDropTarget(box && !(box.spread === start.spread && box.id === start.box) ? box.spread + ':' + box.id : undefined);
    // Near the top or bottom of the canvas, scroll it so another spread can be reached.
    const bounds = canvas.current?.getBoundingClientRect();
    if (bounds) {
      const edge = event.clientY < bounds.top + 48 ? -1 : event.clientY > bounds.bottom - 48 ? 1 : 0;
      if (edge) canvas.current!.scrollBy({ top: edge * 24 });
    }
  });
  const moveDrop = useEffectEvent((event: PointerEvent) => {
    const start = pendingMove.current;
    pendingMove.current = undefined;
    if (!start || !moving) return;
    setMoving(undefined);
    setDropTarget(undefined);
    // The click that follows this pointerup is part of the move.
    moved.current = true;
    setTimeout(() => { moved.current = false; });
    const { box } = locate(event, [photoMime]);
    if (!box || box.type !== 'photo' || !summary || (box.spread === start.spread && box.id === start.box)) return;
    const target = { spread: box.spread, box: box.id };
    const label = template?.spreads[spreads.find(({ id }) => id === target.spread)?.definition ?? '']?.boxes[target.box]?.label ?? target.box;
    let swapped: string | undefined;
    editCanvas(({ project }) => {
      const from = project.spreads.find(({ id }) => id === start.spread);
      const to = project.spreads.find(({ id }) => id === target.spread);
      if (from?.boxes[start.box]?.photo === start.photo && to) swapped = swapContent(from, start.box, to, target.box);
    }, () => sourceTitle(summary, 'photo', start.photo) + (swapped ? ' and ' + sourceTitle(summary, 'photo', swapped) + ' swapped' :
      ' moved to ' + label));
    select(target.spread, false);
    setFocusBox({ box: target.box, at: Date.now() });
  });
  useEffect(() => {
    const move = (event: PointerEvent) => moveDrag(event);
    const up = (event: PointerEvent) => moveDrop(event);
    const cancel = () => {
      pendingMove.current = undefined;
      setMoving(undefined);
      setDropTarget(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  // Changing a spread's layout (including by Undo) ends crop mode and closes the edit popover on that spread, so
  // neither saves into a layout it was not opened for. Element editors notice through their own stale check.
  const layouts = useRef(new Map<string, string>());
  useEffect(() => {
    const changed = new Set(spreads.filter(({ id, definition }) => layouts.current.has(id) && layouts.current.get(id) !== definition)
      .map(({ id }) => id));
    layouts.current = new Map(spreads.map(({ id, definition }) => [id, definition]));
    if (!changed.size) return;
    setCropping((crop) => crop && changed.has(crop.spread) ? undefined : crop);
    setEditing((open) => open && !open.held && changed.has(open.spread) ? undefined : open);
  }, [spreads]);

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropTarget(undefined);
    if (!api || !writable || busy || !summary || readyId.current !== summary.id) return;
    const { box } = locate(event);
    // Kept content dropped on its own spread moves; dropped on another spread it is another use of its source.
    const kept = event.dataTransfer.getData(keptMime);
    if (kept && box && box.type !== 'element') {
      const origin = JSON.parse(kept) as { spread: string; box: string };
      if (origin.spread === box.spread) {
        place(origin.spread, origin.box, box.id, true);
        select(box.spread, false);
        return;
      }
    }
    const photoId = event.dataTransfer.getData(photoMime);
    const textId = event.dataTransfer.getData(textMime);
    if (photoId || textId) {
      if (photoId && box?.type === 'photo' && summary.photoIndex[photoId]) assign(box.spread, box.id, { kind: 'photo', id: photoId });
      if (textId && box?.type === 'markdown' && summary.project.texts[textId]) assign(box.spread, box.id, { kind: 'text', id: textId });
      if (box) select(box.spread, false);
      return;
    }
    const paths = api.pathsForFiles([...event.dataTransfer.files]);
    if (!paths.length) return;
    const kind = box?.type === 'markdown' ? 'markdown' : box?.type === 'photo' ? 'photo' :
      paths.every((path) => /\.md$/i.test(path)) ? 'markdown' : 'photo';
    if (box) select(box.spread, false);
    importFiles({ kind, paths, target: box && box.type !== 'element' ? { spread: box.spread, box: box.id } : undefined }, summary.id);
  }

  // Clicking a box shows its source in the source inspector; double-clicking opens Quick Look.
  function boxSource(spread: string, box: string): SourceRef | undefined {
    const state = spreads.find(({ id }) => id === spread)?.boxes[box];
    if (state?.photo) return { kind: 'photo', id: state.photo };
    if (state?.text) return { kind: 'text', id: state.text };
  }
  function choose(source: SourceRef) {
    setSelectedSource(source);
    setSourceTab(source.kind);
  }

  const quickItems = useMemo(() => summary && quick ? sourceList(summary, quick.kind) : [], [summary, quick]);
  function navigateQuick(step: number) {
    if (!quick) return;
    const at = quickItems.findIndex(({ id }) => id === quick.id);
    const next = quickItems[at + step];
    if (!next) return;
    const source = { kind: quick.kind, id: next.id };
    setQuick(source);
    choose(source);
  }
  // Space opens Quick Look for the selected source unless a control has focus.
  const onSpace = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== ' ' || event.defaultPrevented || quick || !summary) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, [contenteditable], dialog, [role="option"]')) return;
    if (!selectedSource) return;
    event.preventDefault();
    setQuick(selectedSource);
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onSpace(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  function thumbKeys(event: KeyboardEvent) {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const next = step && spreads[index + step];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    thumbList.current?.querySelector<HTMLElement>('[data-spread="' + CSS.escape(next.id) + '"]')?.focus();
  }

  const usage = useMemo(() => summary ? sourceUsage(summary.project, pageLabels, template?.spreads) : { photo: {}, text: {} },
    [summary, template, pageLabels.join()]);
  const activeBox = dropTarget ? geometry?.boxes.find(({ spread, id }) => spread + ':' + id === dropTarget) :
    highlight ? geometry?.boxes.find(({ spread: owner, id }) => owner === spread?.id && id === highlight) : undefined;
  const spreadSelected = !selectedSource;
  const selectedSheet = spreadSelected ? geometry?.sheets.find(({ spread: id }) => id === spread?.id) : undefined;
  const hoveredSheet = hovered !== spread?.id ? geometry?.sheets.find(({ spread: id }) => id === hovered) : undefined;
  const previewError = typeof reload === 'object' ? reload.error : render?.state === 'error' ? render.message : '';
  const issue = previewError || error;
  const previewNotice = agentWorking ? 'Agent is updating the book…' : previewError ? (geometry ? 'Showing the last successful preview' : 'Book preview unavailable') :
    !canvasReady ? 'Building book preview…' : '';
  const blockedInline = editing?.held && !resumeInline && (canvasReady
    ? 'This field changed while you were editing. Close it and open the field again to continue.'
    : 'Editing is paused while the preview is out of date.');
  const canExport = canvasReady && !busy;
  const counts = summary ? assignmentCounts(summary.project, template?.spreads) : {};
  const format = formatOf(template);
  // A saved format the template's named formats no longer include; the Book check reports it and print export is
  // blocked. A template with one fixed format offers no choices and ignores the saved one.
  const missingFormat = !!template && Object.keys(template.formats).length > 0 && !!summary?.project.format &&
    !Object.hasOwn(template.formats, summary.project.format);
  const label = (definition: string, i: number) => template?.spreads[definition]?.label ?? 'Spread ' + (i + 1);
  const pagesLabel = (i: number) => (pageLabels[i].includes('–') ? 'Pages ' : 'Page ') + pageLabels[i];

  return <ProjectFilesContext.Provider value={projectFiles}><div className={navigator.platform.includes('Mac') ? 'studio mac-studio' : 'studio'}>
    <header className="toolbar">
      <div className="toolbar-actions project-context">
        <button className="toolbar-icon" aria-label="Toggle project panel" aria-pressed={!panels.leftHidden} title="Toggle project panel (⌥⌘1)" onClick={() => togglePanel('left')}><Icon name="sidebarLeft" /></button>
        <div className="project-identity" title={summary?.folder}>
          <strong>{summary?.project.title ?? 'ImageFlow'}</strong>
          <span className="muted">{summary ? summary.readOnly ? 'Sample · Read only' : busy ? 'Working…' : 'Saved locally' : 'Photobook studio'}</span>
        </div>
        {summary && <div className="history">
          <button aria-label="Undo" title={summary.history?.undo ? 'Undo ' + summary.history.undo : 'Undo'} disabled={!writable || !summary.history?.undo || !!busy} onClick={() => undo('undo')}><Icon name="undo" /></button>
          <button aria-label="Redo" title={summary.history?.redo ? 'Redo ' + summary.history.redo : 'Redo'} disabled={!writable || !summary.history?.redo || !!busy} onClick={() => undo('redo')}><Icon name="redo" /></button>
        </div>}
      </div>
      <div className="toolbar-actions">
        <div className="export-area">
          {exporting ? <div className="export-progress"><span role="status" title={busy}>{busy}</span><button onClick={() => void api?.cancelExport()}>Cancel export</button></div> : <ActionMenu className="export-menu" disabled={!summary} label={<><Icon name="export" /><span>Export</span><Icon name="chevron" /></>}>
            <div className="export-choices">
              <button className="primary" disabled={!canExport || !checkCurrent || !!check?.errors.length} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); act('print'); }}>Export print PDF</button>
              <button disabled={!canExport} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); act('export'); }}>Export proof PDF</button>
              {!checkCurrent && <p>Checking book… Print export will be available when checks finish.</p>}
              {checkCurrent && !!check?.errors.length && <p>Resolve Book check errors before print export.</p>}
            </div>
          </ActionMenu>}
        </div>
        <button className="toolbar-icon" aria-label="Toggle Inspector" aria-pressed={!panels.rightHidden} title="Toggle Inspector (⌥⌘2)" disabled={!summary} onClick={() => togglePanel('right')}><Icon name="sidebarRight" /></button>
      </div>
    </header>
    <div ref={workspace} inert={agentWorking} key={projectInstance} className={summary ? 'workspace' : 'workspace welcome-workspace'}
      data-resizing={resizing || undefined}
      style={{ '--left-content': panels.left + 'px', '--right-content': panels.right + 'px', '--left-panel': panels.leftHidden ? '0px' : panels.left + 'px', '--right-panel': panels.rightHidden ? '0px' : panels.right + 'px',
        '--left-divider': panels.leftHidden ? '0px' : '6px', '--right-divider': panels.rightHidden ? '0px' : '6px' } as CSSProperties}>
      <aside className={'project-panel' + (panels.leftHidden ? ' is-collapsed' : '')} aria-label="Project" inert={panels.leftHidden} aria-hidden={panels.leftHidden}>
        <div className="project-panel-content">
        <div className="project-head">
          <h1>{summary ? template?.format.label ?? 'Book' : 'Photobook studio'}</h1>
          <p className="muted" title={summary?.folder}>{summary ? (sequence ? sequence.count + ' pages · ' + spreads.length + ' spreads' : 'Loading book…') + (summary.readOnly ? ' · Sample' : '') : 'Local photobook projects'}</p>
          {!summary && <button className="sample-button" disabled={!api || !!busy} onClick={() => act('sample')}>Open sample project</button>}
        </div>
        {summary && <details className="document-settings">
          <summary>Book settings</summary>
          <fieldset disabled={!writable}>
            {template && (Object.keys(template.formats).length > 1 || missingFormat) && <label className="field">Format
              <select value={missingFormat ? summary.project.format : template.formatId} onChange={(event) => {
                const format = event.target.value;
                edit(({ project }) => { project.format = format; }, 'Format changed to ' + template.formats[format]);
              }}>
                {missingFormat && <option value={summary.project.format} disabled>{summary.project.format} (not in the template)</option>}
                {Object.entries(template.formats).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select></label>}
            <label className="field">Book title<input key={summary.project.title} defaultValue={summary.project.title}
              onBlur={(event) => {
                const title = event.target.value.trim();
                if (title && title !== summary.project.title) edit(({ project }) => { project.title = title; });
              }} /></label>
            {template && <Fields schema={template.parameters} values={summary.project.params}
              update={(id, value) => edit(({ project }) => { project.params[id] = value; })} />}
          </fieldset>
        </details>}
        {summary && <>
          <div className="spread-bar">
            <span className="eyebrow">Spreads</span>
            <div className="icon-actions">
              <button aria-label="Add" title="Add spread" disabled={!writable || !template || !!busy} onClick={() => add()}><Icon name="add" /></button>
              <button aria-label="Duplicate" title="Duplicate spread" disabled={!writable || !template || !spreadSelected || !!busy} onClick={() => add(true)}><Icon name="duplicate" /></button>
              <button aria-label="Move spread up" title="Move up" disabled={!writable || !spreadSelected || index === 0 || !!busy} onClick={() => move(-1)}><Icon name="up" /></button>
              <button aria-label="Move spread down" title="Move down" disabled={!writable || !spreadSelected || index === spreads.length - 1 || !!busy} onClick={() => move(1)}><Icon name="down" /></button>
              <button aria-label="Delete" title="Delete spread" disabled={!writable || !spreadSelected || spreads.length < 2 || !!busy} onClick={() => edit(({ project }) => {
                project.spreads = project.spreads.filter(({ id }) => id !== spread.id);
              })}><Icon name="delete" /></button>
            </div>
          </div>
          <div className="thumbs-scroll">
            <div ref={thumbList} className={thumbs ? 'spread-thumbs placed' : 'spread-thumbs'} style={{ height: thumbs?.height }}
              role="group" aria-label="Spreads" onKeyDown={thumbKeys}>
              {spreads.map(({ id, definition }, i) => {
                const rect = thumbs?.sheets.find(({ spread }) => spread === id);
                const level = spreadIssues.get(id);
                return <button key={id} data-spread={id}
                  aria-current={spreadSelected && index === i ? 'page' : undefined} aria-label={label(definition, i) + ' ' + pageLabels[i]}
                  title={pagesLabel(i) + ' · ' + label(definition, i) + (level ? ' · ' + (level === 'error' ? 'Has errors' : 'Has warnings') : '')}
                  className={'spread-thumb' + (inView.includes(id) ? ' in-view' : '')} tabIndex={index === i ? 0 : -1}
                  style={rect ? { left: rect.x - 5, top: rect.y - 5, width: rect.width + 10, height: rect.height + 30 } : undefined}
                  onClick={() => select(id)}>
                  <span className="spread-thumb-label">
                    {level && <span className={'issue-dot issue-' + level} />}
                    <span className="pages">{pageLabels[i]}</span>
                    <span className="name">{label(definition, i)}</span>
                  </span>
                </button>;
              })}
              <BookFrame project={summary.id} view="thumbs" title="Spread thumbnails" onGeometry={setThumbs}
                hold={holdPreview} accept={acceptCandidate} />
            </div>
          </div>
        </>}
        </div>
      </aside>
      {!panels.leftHidden ? <PanelDivider side="left" width={panels.left} resize={resizePanel} onResizing={setResizing} /> : <div />}
      <div className="workspace-center">
        <div ref={canvasWrap} className="canvas-wrap">
          <main ref={canvas} className="canvas" aria-label="Book preview" onScroll={measureView}
            onDragOver={(event) => {
              if (!writable || !canvasReady || !event.dataTransfer.types.some((type) => type === 'Files' || type === photoMime || type === textMime)) return;
              event.preventDefault();
              const { box } = locate(event, event.dataTransfer.types);
              setDropTarget(box ? box.spread + ':' + box.id : undefined);
            }} onDragLeave={() => setDropTarget(undefined)} onDrop={drop}>
            {summary && <div ref={stage} className="stage"
              style={{ height: geometry?.height, cursor: hoveredTarget ? 'pointer' : undefined,
                '--aspect': format ? format.spreadWidth / format.height : undefined } as CSSProperties}
              onClick={(event) => {
                // A click that ended a photo move is not a click.
                if (moved.current) return;
                const { sheet, top, target } = locate(event);
                if (!sheet || !spreads.some(({ id }) => id === sheet)) return;
                select(sheet, false);
                if (blockedInline) return;
                if (top) setFocusBox({ box: top.id, at: Date.now() });
                // What is drawn on top decides: a box or element opens its own editor there (see openOwner). A smaller
                // click-to-edit node on top, such as a heading over a photo, opens its popover instead.
                const own = !target || (!!top && (target.edits.every((path) =>
                  path.startsWith((top.type === 'element' ? 'elements.' : 'boxes.') + top.id + '.')) ||
                  (Math.abs(target.width - top.width) < 1 && Math.abs(target.height - top.height) < 1)));
                if (top && own) openOwner(top.spread, { type: top.type, id: top.id });
                else if (target) setEditing({ spread: target.spread, key: targetKey(target) });
              }}
              onDoubleClick={(event) => {
                // Double-clicking a Markdown box shows its text in Quick Look.
                const { top } = locate(event);
                const source = top?.type === 'markdown' && boxSource(top.spread, top.id);
                if (source) setQuick(source);
              }}
              onPointerDown={(event) => {
                // Pressing an unselected photo may start moving it to another box (the selected one pans instead).
                if (event.button !== 0 || !writable || busy) return;
                const { top } = locate(event);
                const photo = top?.type === 'photo' && spreads.find(({ id }) => id === top.spread)?.boxes[top.id]?.photo;
                pendingMove.current = photo ? { spread: top.spread, box: top.id, photo, x: event.clientX, y: event.clientY } : undefined;
              }}
              onMouseMove={(event) => {
                const { sheet, target } = locate(event);
                setHovered(sheet);
                setHoveredTarget(target && targetKey(target));
              }} onMouseLeave={() => { setHovered(undefined); setHoveredTarget(undefined); }}>
              <BookFrame project={summary.id} view="book" title="Book preview" onGeometry={setGeometry} onStatus={bookStatus}
                viewport={viewport} hold={holdPreview} accept={acceptCandidate} />
              {geometry?.sheets.map(({ spread: id, x, y, width }) => {
                const i = spreads.findIndex((item) => item.id === id);
                if (i < 0) return null;
                const level = spreadIssues.get(id);
                return <div key={id} className={'sheet-label' + (spreadSelected && id === spread?.id ? ' selected' : '')} style={{ left: x, top: y - 26, width }}>
                  {level && <span className={'issue-dot issue-' + level} />}{pagesLabel(i)} · {label(spreads[i].definition, i)}
                </div>;
              })}
              {hoveredSheet && <div className="sheet-hover" aria-hidden="true" style={{
                left: hoveredSheet.x, top: hoveredSheet.y, width: hoveredSheet.width, height: hoveredSheet.height }} />}
              {selectedSheet && <div className="sheet-selection" aria-hidden="true" style={{
                left: selectedSheet.x, top: selectedSheet.y, width: selectedSheet.width, height: selectedSheet.height }} />}
              {showGuides && format && geometry?.sheets.map((sheet) => <Guides key={sheet.spread} sheet={sheet} format={format} />)}
              {activeBox && <div className="box-highlight" aria-hidden="true" style={{
                left: activeBox.x, top: activeBox.y, width: activeBox.width, height: activeBox.height,
              }} />}
              {geometry?.targets.filter((target) => {
                const key = targetKey(target);
                return !cropping && (key === hoveredTarget || key === editing?.key);
              }).map((target) => <div key={targetKey(target)} aria-hidden="true"
                className={'edit-target' + (targetKey(target) === editing?.key ? ' active' : '')}
                style={{ left: target.x - 4, top: target.y - 3, width: target.width + 8, height: target.height + 6 }} />)}
              {moving && summary?.photos[moving.photo] && <img className="photo-move-ghost" src={summary.photos[moving.photo]} alt=""
                style={{ left: moving.x, top: moving.y }} />}
              {cropping && cropFrame && cropPhoto && summary && <CropEditor key={cropping.spread + ':' + cropping.box}
                frame={cropFrame} photo={summary.photoSizes[cropPhoto]} src={renderOrigin + '/render/' + summary.id + '/photo/' + cropPhoto}
                placement={cropPlacement} settling={!!cropping.settling}
                inchesPerPixel={format && cropSheet ? format.spreadWidth / cropSheet.width / 25.4 : undefined}
                resolution={template?.format.output.resolution} save={saveCrop} close={deselectPhoto}
                toolbarHost={canvasWrap.current}>
                {/* The box's photo and its own parameters (such as Show caption) sit with the selected photo. Replacing or
                    removing the photo ends the selection. */}
                {cropState && summary && <div className="crop-params crop-content">
                  <PhotoContent summary={summary} spread={spreads.find(({ id }) => id === cropping.spread)!} box={cropping.box} compact values
                    label={cropBox?.label ?? cropping.box} assigned={deselectPhoto}
                    change={(update, notice) => changeSpreadAt(cropping.spread, update, notice)} />
                </div>}
                {cropBox && Object.keys(cropBox.parameters).length > 0 && <div className="crop-params">
                  <Fields schema={cropBox.parameters} controls={cropBox.controls} values={cropState?.params ?? {}} update={(key, value) => edit(({ project }) => {
                    const state = project.spreads.find(({ id }) => id === cropping.spread);
                    if (state?.definition !== cropping.layout || state.boxes[cropping.box]?.photo !== cropPhoto) return;
                    state.boxes[cropping.box].params[key] = value;
                  }, cropBox.parameters[key].label + ' updated')} />
                </div>}
              </CropEditor>}
              {editing && inline && summary && <EditPopover key={editing.key}
                project={inline.project} spread={inline.spread} template={inline.template} edits={inline.target.edits} anchor={inline.target}
                bounds={{ width: stage.current?.clientWidth ?? 0 }} readOnly={summary.readOnly} blocked={blockedInline || undefined}
                edit={editInline} close={closeEditor} step={stepEditor} title={editing.owner && ownerLabel(inline.spread, editing.owner)}
                actions={!editing.owner && editPhotoBox && !cropBlocked(editing.spread, editPhotoBox)
                  ? <button type="button" onClick={() => startCrop(editing.spread, editPhotoBox)}>Adjust crop…</button>
                  : editElement && editorOf(editing.spread, editElement)
                    ? <button type="button" onClick={() => openElementEditor(editing.spread, editElement)}>
                      {(editorOf(editing.spread, editElement)!.label ?? 'Open editor') + '…'}</button> : undefined}>
                {editing.owner?.type === 'photo' && <PhotoContent summary={summary} spread={inline.spread} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose} values={!!boxSource(editing.spread, editing.owner.id)}
                  adjustCrop={cropBlocked(editing.spread, editing.owner.id) ? undefined : () => startCrop(editing.spread, editing.owner!.id)} />}
                {editing.owner?.type === 'markdown' && <TextContent summary={summary} spread={inline.spread} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose}
                  flow={readyFlow?.[editing.spread + ':' + editing.owner.id]}
                  importText={() => importFiles({ kind: 'markdown', target: { spread: editing.spread, box: editing.owner!.id } })} />}
              </EditPopover>}
            </div>}
            {!summary && <div className="welcome">
              <span className="welcome-icon" aria-hidden="true">◫</span>
              <h2>See your book take shape</h2>
              <p>{api ? 'Create a book with the starter template, open a project you trust, or preview the Senja sample.' :
                'Launch the desktop app to open an ImageFlow project.'}</p>
              {api && <div className="welcome-actions">
                <button disabled={!!busy} onClick={() => act('new')}>New project…</button>
                <button disabled={!!busy} onClick={() => act('open')}>Open project…</button>
                <button className="primary" disabled={!!busy} onClick={() => act('sample')}>Try the Senja sample</button></div>}
            </div>}
          </main>
          {summary && previewNotice && <div className={geometry ? 'preview-state' : 'preview-message'} role="status">{previewNotice}</div>}
          {summary && <label className="guides-toggle"><input type="checkbox" checked={showGuides}
            onChange={(event) => setShowGuides(event.target.checked)} /> Guides</label>}
        </div>
        {summary && <Sources summary={summary} tab={sourceTab} setTab={setSourceTab}
          selected={selectedSource ? { [selectedSource.kind]: selectedSource.id } : {}} choose={choose}
          usage={usage} writable={writable} busy={!!busy} importSources={act} quickLook={setQuick}
          importPaths={(files) => {
            const paths = api?.pathsForFiles(files) ?? [];
            if (paths.length) importFiles({ kind: paths.every((path) => /\.md$/i.test(path)) ? 'markdown' : 'photo', paths });
          }} />}
      </div>
      {summary && (!panels.rightHidden ? <PanelDivider side="right" width={panels.right} resize={resizePanel} onResizing={setResizing} /> : <div />)}
      <div className={'inspector-host' + (panels.rightHidden ? ' is-collapsed' : '')} inert={panels.rightHidden} aria-hidden={panels.rightHidden || !summary}>
      {summary && spread && <Inspector summary={writable || summary.readOnly ? summary : { ...summary, readOnly: true }}
        spread={spread} source={selectedSource} template={template} render={render ?? lastReady}
        usage={usage} quickLook={() => selectedSource && setQuick(selectedSource)} focus={focusBox}
        targets={geometry?.targets.filter((target) => target.spread === spread.id)}
        open={(owner) => { reveal(spread.id); openOwner(spread.id, owner); }} place={(from, to) => place(spread.id, from, to)}
        edit={edit} highlight={setHighlight} issues={issue} select={select} />}
      </div>
    </div>
    {summary && template && elementEditor && spreads.some(({ id }) => id === elementEditor.spread) &&
      <ElementEditorDialog key={elementEditor.spread + ':' + elementEditor.element} project={summary.id} template={template}
        spread={spreads.find(({ id }) => id === elementEditor.spread)!} element={elementEditor.element} readOnly={summary.readOnly}
        blocked={previewNotice || undefined}
        edit={editCanvas} close={() => setElementEditor(undefined)} importFile={importProjectFile} />}
    {summary && quick && <QuickLook summary={summary} source={quick} usage={usage} navigate={navigateQuick}
      close={() => setQuick(undefined)} jump={(id) => select(id)} />}
    <footer className="status-bar">
      <span title={issue || busy || notice || undefined} className={issue ? 'status status-error' : 'status'} role={issue && !summary ? 'alert' : 'status'}>
        {issue || busy || notice || (summary ? 'Project preview · Proof export' : 'ImageFlow for macOS')}
      </span>
      <McpPanel api={api} />
      {summary && <BookCheckIndicator check={check} checking={!checkCurrent} spread={spreadSelected ? spread?.id ?? '' : ''} select={select} />}
    </footer>
  </div></ProjectFilesContext.Provider>;
}
