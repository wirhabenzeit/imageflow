import { usePhotoView } from './PhotoViewMenu';
import { isPhotoViewCommand } from './photo-view';
import { captureViewAnchor, restoreViewAnchor } from './view-anchor';
import type { ViewAnchor } from './view-anchor';
import { assetUsage } from './asset-usage';
import { sourcePlacements } from './source-placement';
import { importFeedback } from './import-feedback';
import { Presentation } from './Presentation';
import { commandState } from './commands';
import type { BookMenuState } from './desktop';
import { bookName } from './book-name';
import type { ImportMode } from './source-locations';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import { bookLayout, gridColumns, renderOrigin, spreadCommands } from './desktop';
import { resolveTarget, targetAnchor, targetKey } from './edit-targets';
import type { TargetAnchor } from './edit-targets';
import type { BookGeometry, CanvasLayout, Command, ImportRequest, Issue, ProjectChange, ProjectSummary, Rect, RenderStatus, TemplateInfo } from './desktop';
import { PanelDivider, useCanvasLayout, usePanels } from './panels';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { BookFrame } from './BookFrame';
import type { CropPreview } from './BookFrame';
import { AgentStatus } from './AgentStatus';
import { revealIn } from './reveal';
import { EditPopover, MarkedFields } from './EditPopover';
import { CropEditor } from './CropEditor';
import { ElementEditorDialog } from './ElementEditor';
import { documentEditorFor, editorOwnedDocument, editorTargetGone } from './editor-session';
import { anchoredTarget, clickWithin, elementRect, hiddenOccurrence, inlinePlacement, presentationFor } from './inline-editors';
import type { OpenEditor } from './inline-editors';
import { LayoutFamilyPicker } from './LayoutFamilyPicker';
import { InlineTextEditor } from './InlineTextEditor';
import { textEditorOwner, textFits } from './inline-text';
import { PhotoContent, TextContent } from './BoxContent';
import { ProjectFilesContext } from './Fields';
import { centered, getCrop, placementIn, placementOf, setPlacement } from './spread';
import type { Placement } from './spread';
import { assignmentCounts, firstSpreadLayouts, newSpread, openingSpreadStates, readEdit, resolveEditPath } from './editing';
import { moveContent, pickerFamily, swapContent, layoutPreviews, switchLayout } from './layouts';
import { Fields } from './Fields';
import { Inspector } from './Inspector';
import type { Edit } from './Inspector';
import { BookCheckIndicator } from './BookCheck';
import type { PictureStatus } from './BookFrame';
import type { BookCheck } from './BookCheck';
import { QuickLook, Sources } from './Sources';
import { keptMime, photosMime, photoMime, sourceList, sourceTitle, textMime } from './source-items';
import type { SourceKind, SourceRef } from './source-items';
import { hasFacingPages, hasSingleEnds, pageNumbers, pageLabel, pageSequence, pagesText, resolveFormat, sheetPages } from './format';
import type { ResolvedFormat } from './format';
import type { ProjectFiles, SpreadState } from './project';
import { useListSelection } from './list-selection';
import { insertionProblem, spreadOrder, spreadSelectionOrder } from './spread-order';
import { spreadMime, useSpreadReorder } from './useSpreadReorder';
import { animateReorder, reorderOffsets } from './reorder-motion';

type Owner = { type: 'photo' | 'markdown' | 'element'; id: string };
// `hidden`: the box or element is declared but not on the page, so the editor opens at the spread's corner.
type Target = BookGeometry['targets'][number] & { hidden?: boolean };
type InlineContext = {
  project: ProjectFiles['project']; spread: SpreadState; template: TemplateInfo; target: Target;
};

function inlineValues({ project, spread, template, target }: InlineContext) {
  return JSON.stringify([spread.definition, target.edits.map((path) => {
    const field = resolveEditPath(template, spread.definition, path);
    return [field, field && readEdit(project, spread, field)];
  })]);
}

const isGridColumns = (command: Command): command is `grid-columns-${typeof gridColumns[number]}` =>
  gridColumns.some((count) => command === `grid-columns-${count}`);

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
  const pages = sheetPages(format);
  return <div className="guides" aria-hidden="true" style={{ left: sheet.x, top: sheet.y, width: sheet.width, height: sheet.height }}>
    <div className="trim-guide" style={{ left: pages[0].trimX * x, top: bleed.top * y, width: trim.width * pages.length * x, height: trim.height * y }} />
    {pages.length > 1 && <div className="gutter-guide" style={{ left: sheet.width / 2, top: 0, height: sheet.height }} />}
    {pages.map(({ side, trimX, safeLeft, safeRight }) => <div className="safe-guide" key={side} style={{
      left: (trimX + safeLeft) * x,
      top: (bleed.top + safe.top) * y,
      width: (trim.width - safeLeft - safeRight) * x, height: (trim.height - safe.top - safe.bottom) * y,
    }} />)}
  </div>;
}

// An empty book asks for its first spread: the template's opening spreads, or one layout that can start a book.
function EmptyBook({ template, writable, start }: { template?: TemplateInfo; writable: boolean; start: (layout?: string) => void }) {
  const layouts = template ? firstSpreadLayouts(template.spreads, template.format) : [];
  const opening = template?.openingSpreads ?? [];
  return <section className="empty-book" aria-labelledby="empty-book-title">
    <div className="empty-book-art" aria-hidden="true"><span /><span /></div>
    <h2 id="empty-book-title">This book has no spreads yet</h2>
    {!template ? <p className="muted">Loading the template…</p> : !writable ? <p className="muted">Spreads can be added once the book can be edited.</p> : <>
      {opening.length > 0 && <button className="primary" onClick={() => start()}>
        Add {opening.length === 1 ? 'the opening spread' : 'the ' + opening.length + ' opening spreads'}</button>}
      {layouts.length > 0 ? <div className="empty-book-layouts" role="group" aria-label="Layouts for the first spread">
        {layouts.map((id) => <button key={id} onClick={() => start(id)}>
          {template.spreads[id].label}</button>)}
      </div> : <p className="error-text">This template has no layout that can start a book.</p>}
    </>}
  </section>;
}

export function App() {
  const api = window.imageflow;
  const { panels, bottomMaximum, toggle: togglePanelState, show: showPanelState, resize: resizePanelState } = usePanels();
  const [resizing, setResizing] = useState(false);
  const [summary, setSummary] = useState<ProjectSummary>();
  useEffect(() => { if (summary) document.title = bookName(summary.folder); }, [summary?.folder]);
  const photoView = usePhotoView(summary?.viewKey ?? summary?.folder);
  const [projectInstance, setProjectInstance] = useState(0);
  const current = useRef<ProjectSummary>(undefined);
  const [spreadId, setSpreadId] = useState('');
  const [presenting, setPresenting] = useState<string>();
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
  const [thumbnailState, setThumbnailState] = useState<{ geometry?: BookGeometry; animate: boolean }>({ animate: true });
  const thumbs = thumbnailState.geometry;
  function setThumbs(geometry: BookGeometry | undefined, animate = true) {
    setThumbnailState({ geometry, animate });
  }
  const [hovered, setHovered] = useState<string>();
  const [hoveredTarget, setHoveredTarget] = useState<string>();
  // The inline editor that is open: for a marked node (a target), or for a box or element itself (`owner`).
  // `session` names one opening of an editor: it stays while the node the editor is anchored to is renamed (`key`), so
  // the popover and its unsaved drafts are kept, and changes when the user opens another target.
  const [editing, setEditing] = useState<{ spread: string; key: string; session: number; held?: InlineContext; owner?: Owner; panel?: boolean; text?: boolean }>();
  const editorSessions = useRef(0);
  const openEditing = (next: { spread: string; key: string; owner?: Owner; panel?: boolean }) => {
    const target = geometry?.targets.find((item) => targetKey(item) === next.key);
    if (target?.inlineText && openTextOwner(target)) return;
    const state = summary?.project.spreads.find(({ id }) => id === next.spread);
    const text = !!(!next.owner && !next.panel && !summary?.readOnly && canvasReady && readyId.current === summary?.id && target && textFits(target));
    setEditing({ ...next, session: ++editorSessions.current, text,
      ...(text && summary && template && state && target ? { held: { project: summary.project, spread: state, template, target } } : {}) });
  };
  // Crop mode for one photo box. After a commit, `settling` holds the project id the edit started from; the
  // overlay stays until the book has re-rendered, so the frame does not flash back to the old crop.
  // The selected photo, whose crop drags and pinches adjust. `layout` is the spread's layout when it was selected:
  // each layout has its own crop. `saved` holds the project id the last crop edit started from; after the photo is
  // deselected, `settling` keeps its overlay until the book has re-rendered, so the frame does not flash back.
  const [cropping, setCropping] = useState<{ spread: string; box: string; layout: string; saved?: string; settling?: string }>();
  // The unsaved placement of a crop gesture on a box the template draws with a render callback, which the book view draws.
  const [cropPreview, setCropPreview] = useState<CropPreview>();
  // A template-supplied editor that is open: an element's, or a document editor opened from a spread.
  const [elementEditor, setElementEditor] = useState<OpenEditor>();
  // Whether an inline editor is showing in place of the artwork it edits, which the book view then hides.
  const [inlineShown, setInlineShown] = useState(false);
  // An inline editor that has closed stays over the page until the book shows its artwork again, so nothing flickers.
  const [leavingEditor, setLeavingEditor] = useState<OpenEditor>();
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
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const [zoom, setZoomState] = useState(1);
  const setZoom: typeof setZoomState = (next) => { if (typeof next === 'number' && next === zoom) return; preserveViewAnchor(); setZoomState(next); };
  const [textEditing, setTextEditing] = useState(false);
  const [checkRequest, setCheckRequest] = useState(0);
  const [checkScope, setCheckScope] = useState<string>();
  const [controlFocused, setControlFocused] = useState(false);
  const [spreadFocused, setSpreadFocused] = useState(false);
  useEffect(() => {
    const focus = () => setSpreadFocused(!!document.activeElement?.closest('.spread-thumb, .canvas'));
    const pointer = (event: PointerEvent) => setSpreadFocused(event.target instanceof Element && !!event.target.closest('.spread-thumb, .canvas'));
    document.addEventListener('focusin', focus); document.addEventListener('pointerdown', pointer, true);
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('pointerdown', pointer, true); };
  }, []);
  useEffect(() => {
    const focus = () => setControlFocused(!!document.activeElement?.closest('input, textarea, select, [contenteditable], iframe, dialog, .edit-popover, .crop-toolbar'));
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focus);
    focus();
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus); };
  }, []);

  useEffect(() => {
    const isText = (node: Element | null) => !!node?.matches('textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="file"])');
    const focus = () => setTextEditing(isText(document.activeElement));
    const message = (event: MessageEvent) => {
      if (event.origin === renderOrigin && event.data?.type === 'editor-focus' && document.activeElement instanceof HTMLIFrameElement &&
          event.source === document.activeElement.contentWindow) setTextEditing(event.data.text === true);
    };
    document.addEventListener('focusin', focus); document.addEventListener('focusout', focus); window.addEventListener('message', message);
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus); window.removeEventListener('message', message); };
  }, []);
  const [error, setError] = useState('');
  const [check, setCheck] = useState<BookCheck>();
  const canvas = useRef<HTMLElement>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const thumbList = useRef<HTMLDivElement>(null);
  const previousThumbs = useRef<BookGeometry>(undefined);
  const thumbAnimations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    thumbAnimations.current.forEach(animation => animation.cancel());
    thumbAnimations.current = [];
    const offsets = reorderOffsets(previousThumbs.current, thumbs);
    previousThumbs.current = thumbs;
    if (!thumbnailState.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const offset of offsets) {
      const node = thumbList.current?.querySelector<HTMLElement>('.spread-thumb[data-spread="' + CSS.escape(offset.spread) + '"]');
      if (node) thumbAnimations.current.push(animateReorder(node, offset));
    }
    return () => { thumbAnimations.current.forEach(animation => animation.cancel()); };
  }, [thumbs, thumbnailState.animate]);
  useEffect(() => {
    const cancel = () => {
      thumbAnimations.current.forEach(animation => animation.cancel());
      for (const frame of thumbList.current?.querySelectorAll<HTMLIFrameElement>('iframe') ?? []) {
        frame.contentWindow?.postMessage({ type: 'cancel-reorder' }, renderOrigin);
      }
    };
    const list = thumbList.current;
    list?.addEventListener('pointerdown', cancel, true);
    list?.addEventListener('dragstart', cancel, true);
    return () => {
      list?.removeEventListener('pointerdown', cancel, true);
      list?.removeEventListener('dragstart', cancel, true);
      cancel();
    };
  }, [projectInstance]);
  const pendingReveal = useRef<string>(undefined);
  const viewAnchor = useRef<ViewAnchor>(undefined);
  const pendingAnchor = useRef<ViewAnchor>(undefined);
  const anchorLayout = useRef<string>(undefined);
  const anchorSize = useRef<string>(undefined);
  const queue = useRef(Promise.resolve());
  const agentLocked = useRef(false);
  const [agentWorking, setAgentWorking] = useState(false);
  const pendingTasks = useRef(0);
  const [saving, setSaving] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useCanvasLayout(summary?.folder);
  const columns = layout.mode === 'grid' ? layout.columns : 0;
  const spreads = summary?.project.spreads ?? [];
  const spreadSelection = useListSelection(spreads.map(({ id }) => id), (id) => template?.spreads[spreads.find((spread) => spread.id === id)?.definition ?? '']?.label ?? id);
  const selectedSpreads = spreadSelection.selected.length ? spreadSelection.selected : spreadId ? [spreadId] : [];
  useEffect(() => {
    if (selectedSource) spreadSelection.setSelection([]);
    else if (spreadId && !spreadSelection.selected.includes(spreadId)) spreadSelection.setSelection([spreadId]);
  }, [spreadId, selectedSource, projectInstance]);
  const index = Math.max(0, spreads.findIndex(({ id }) => id === spreadId));
  const spread = spreads[index];
  const layoutFamily = spread && template && pickerFamily(template.spreads, spread.definition, template.layoutFamilies);
  const sequence = template && pageSequence(spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const pageLabels = spreads.map((_, i) => pageLabel(sequence?.spreads[i]?.page ?? {}));
  const writable = !!summary && !summary.readOnly && !reload && !agentWorking;
  const canvasReady = render?.state === 'ready' && !reload;
  const holdPreview = reload === 'loading' || typeof reload === 'object';
  const generation = inputGeneration.current;
  const spreadSelected = !selectedSource;
  const canChangeBook = writable && !busy && !exporting;
  const canReorder = canChangeBook && !!template;
  const canMoveSpread = (id: string, target: number) => !!template && !!spreadOrder(spreads, id, target, template);
  // An empty book adds its first spread; otherwise a spread-wide layout is needed, or a page layout without facing pages.
  const canAdd = canChangeBook && !!template && (!spread ? firstSpreadLayouts(template.spreads, template.format).length > 0
    : Object.values(template.spreads).some(({ span }) => span === (hasFacingPages(template.format) ? 'spread' : 'page')));
  // A single opening or closing page cannot be duplicated where the format requires one of each.
  const canDuplicate = canChangeBook && !!template && spreadSelected && !!spread &&
    !selectedSpreads.some((id) => hasSingleEnds(template.format) && ['left', 'right'].includes(template.spreads[spreads.find((spread) => spread.id === id)?.definition ?? '']?.span ?? ''));
  const canDelete = canChangeBook && spreadSelected && !!spread;
  const canMoveUp = canReorder && spreadSelected && !!spread && (selectedSpreads.length > 1 ? !!spreadSelectionOrder(spreads, selectedSpreads, 'up', template!) : canMoveSpread(spread.id, index - 1));
  const canMoveDown = canReorder && spreadSelected && !!spread && (selectedSpreads.length > 1 ? !!spreadSelectionOrder(spreads, selectedSpreads, 'down', template!) : canMoveSpread(spread.id, index + 1));
  // This is the render-session ID, regenerated by DocumentSession.activate() on save, history and reload.
  const reorder = useSpreadReorder({ list: thumbList, revision: summary?.id, enabled: canReorder && !panels.leftHidden,
    canMove: canMoveSpread, move: moveTo });

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
    if (!reset) {
      preserveViewAnchor();
      if (current.current?.project.format !== next.project.format) revealedThumb.current = '';
    }
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
      spreadSelection.setSelection([]);
      setProjectInstance((previous) => previous + 1);
      clearCanvasEditors();
      pendingReveal.current = undefined;
      viewAnchor.current = undefined; pendingAnchor.current = undefined;
      revealedThumb.current = '';
      canvas.current?.scrollTo({ top: 0, left: 0 });
    }
    // A book may have no spreads yet; then nothing is selected.
    setSpreadId((previous) => selected ?? (reset ? next.project.spreads[0]?.id :
      next.project.spreads.find(({ id }) => id === previous)?.id ?? next.project.spreads[0]?.id) ?? '');
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
    return queue.current;
  }

  async function persist<T>(operation: () => Promise<T>) {
    setSaving(true);
    try { return await operation(); } finally { setSaving(false); }
  }

  // `notice` may be a function, read after the change ran, for notices that describe what the change found.
  function edit(change: (files: ProjectFiles) => void | false, notice?: string | (() => string), selected?: string, canvasId?: string) {
    let applied = false;
    return enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
          (canvasId && (before.id !== canvasId || readyId.current !== canvasId))) return;
      const files = structuredClone({ project: before.project, photoIndex: before.photoIndex });
      if (change(files) === false) return;
      if (template) files.project.template.version = template.version;
      if (JSON.stringify(files.project) === JSON.stringify(before.project) &&
          JSON.stringify(files.photoIndex) === JSON.stringify(before.photoIndex)) { applied = true; return; }
      const label = (typeof notice === 'function' ? notice() : notice) ?? 'Project edit';
      const result = await persist(() => api.saveProject(before.id, files, label));
      if ('error' in result) throw new Error(result.error);
      if (current.current !== before) return;
      adopt(result.value, false, selected);
      setNotice((typeof notice === 'function' ? notice() : notice) ?? '');
      applied = true;
    }).then(() => applied);
  }

  function editCanvas(change: Edit, notice?: string | (() => string)) {
    if (summary && readyId.current === summary.id) edit(change, notice, undefined, summary.id);
  }

  function undo(direction: 'undo' | 'redo') {
    const generation = inputGeneration.current;
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current) return;
      const result = await persist(() => api.history(before.id, direction));
      if ('error' in result) throw new Error(result.error);
      if (current.current !== before) return;
      adopt(result.value);

    });
  }

  function importFiles(request: ImportRequest, canvasId?: string) {
    const generation = inputGeneration.current;
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
          (canvasId && (before.id !== canvasId || readyId.current !== canvasId))) return;
      setBusy('Importing files…');
      const result = await persist(() => api.importFiles(before.id, request));
      if ('error' in result) throw new Error(result.error);
      if (!result.value || current.current !== before) return;
      if (result.value.imported.length) adopt(result.value.summary);
      // Imports into the library select the first new source; imports onto a box keep the spread selected.
      if (!request.target && result.value.imported.length) {
        const kind = result.value.summary.photoIndex[result.value.imported[0]] ? 'photo' : 'text';
        setSourceTab(kind);
        setSelectedSource({ kind, id: result.value.imported[0] });
      }
      setNotice(importFeedback(result.value.imported.length, result.value.counts));
    });
  }

  // Adds a file for a file parameter to the project's registry and resolves to its ID; the caller assigns it as
  // a normal edit, so Undo removes the assignment and keeps the file.
  function importParameterFile(accept: string[], mode?: ImportMode) {
    return importProjectFile(accept, mode).then((imported) => imported?.id);
  }
  // The same, also naming the render session that has the new file, for an element editor frame to read it from.
  function importProjectFile(accept: string[], mode?: ImportMode) {
    const generation = inputGeneration.current;
    return new Promise<{ id: string; project: string } | undefined>((resolve) => enqueue(async () => {
      try {
        const before = current.current;
        if (!api || !before || before.readOnly || agentLocked.current || reloading.current || generation !== inputGeneration.current) return resolve(undefined);
        setBusy('Importing file…');
        const result = await persist(() => api.importFiles(before.id, { kind: 'file', accept, mode }));
        if ('error' in result) throw new Error(result.error);
        if (!result.value || current.current !== before) return resolve(undefined);
        setNotice(importFeedback(result.value.imported.length, result.value.counts));
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

  async function showAssets() {
    if (!api) return;
    const groups = template ? [template.parameters, ...Object.values(template.spreads).flatMap((spread) => [spread.parameters,
      ...Object.values(spread.boxes).map((box) => box.parameters), ...Object.values(spread.elements).map((element) => element.parameters)])] : [];
    const accept = [...new Set(groups.flatMap((group) => Object.values(group).flatMap((param) => param.type === 'file' ? param.accept : [])))];
    const result = await api.showAssets(accept);
    if ('error' in result) setError(result.error);
  }

  function act(command: Command) {
    if (isPhotoViewCommand(command)) { photoView.command(command); return; }
    if (command === 'presentation' || command === 'presentation-start') {
      if (summary && !editing && !cropping && !elementEditor) setPresenting(command === 'presentation-start' ? summary.project.spreads[0]?.id ?? '' : spreadId);
      return;
    }
    if (command === 'book-check') { setCheckScope(undefined); setCheckRequest((value) => value + 1); return; }
    if ((spreadCommands as readonly string[]).includes(command)) {
      // Native accelerators must never delete/reorder a spread while a field or another editor owns the keyboard.
      if (controlFocused || editing || cropping || elementEditor || quick) return;
      if (command === 'add-spread' && canAdd) add();
      if (command === 'duplicate-spread' && canDuplicate) { if (selectedSpreads.length > 1) duplicateSelected(selectedSpreads); else add(true); }
      if (command === 'move-spread-up' && canMoveUp) { if (selectedSpreads.length > 1) moveSelected(selectedSpreads, 'up'); else move(-1); }
      if (command === 'move-spread-down' && canMoveDown) { if (selectedSpreads.length > 1) moveSelected(selectedSpreads, 'down'); else move(1); }
      if (command === 'delete-spread' && canDelete && spreadFocused) deleteSelected(selectedSpreads);
      return;
    }

    if (command === 'manage-sources' || command === 'save-copy') {
      enqueue(async () => { if (command === 'manage-sources') await showAssets(); else { const result = await api?.saveCopy(); if (result && 'error' in result) setError(result.error); } });
      return;
    }
    if (command === 'toggle-project' || command === 'toggle-inspector' || command === 'toggle-sources') {
      togglePanel(command === 'toggle-project' ? 'left' : command === 'toggle-inspector' ? 'right' : 'bottom');
      return;
    }
    if (command === 'toggle-guides') { setShowGuides((value) => !value); return; }
    if (command === 'layout-vertical' || command === 'layout-grid') {
      changeLayout({ ...layout, mode: command === 'layout-grid' ? 'grid' : 'vertical' });
      return;
    }
    if (isGridColumns(command)) {
      changeLayout({ mode: 'grid', columns: Number(command.slice('grid-columns-'.length)) });
      return;
    }
    if (command === 'undo' || command === 'redo') { if (!textEditing) return undo(command); return; }
    if (command === 'zoom-in') { setZoom((value) => Math.min(3, value * 1.2)); return; }
    if (command === 'zoom-out') { setZoom((value) => Math.max(.3, value / 1.2)); return; }
    if (command === 'zoom-fit') { setZoom(1); return; }
    if (command === 'zoom-actual') {
      const width = canvas.current?.clientWidth ?? 1;
      setZoom(format ? Math.max(.3, Math.min(3, (format.spreadWidth * 96 / 25.4 + 64) / width)) : 1); return;
    }
    if (command === 'import') return importFiles({});
    if (command === 'copy-assets') {
      edit(({ project }) => { project.importMode = project.importMode === 'link' ? 'copy' : 'link'; }, 'Import policy changed');
      return;
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
      if (command !== 'new' && command !== 'open') return;
      setBusy(command === 'new' ? 'Creating project…' : 'Opening project…');
      const result = await api.openProject(command);
      if ('error' in result) throw new Error(result.error);
      // New/Open belongs to its own window; this editor keeps its book.
    });
  }

  const viewCommand = (command: Command) => isPhotoViewCommand(command) || command.startsWith('toggle-') || command.startsWith('layout-') || command.startsWith('grid-columns-') || command.startsWith('zoom-') || command === 'book-check' || command === 'presentation' || command === 'presentation-start';
  const onCommand = useEffectEvent((command: Command) => { if (viewCommand(command) || (!busy && !agentLocked.current)) act(command); });
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
    if (pendingTasks.current || busy || reloadRunning || editing || elementEditor || cropping || reorder.dragging || typing || agentLocked.current) return false;
    agentLocked.current = true;
    if (workspace.current) workspace.current.inert = true;
    setAgentWorking(true);
    return true;
  });
  function placeSources(keys: string[], target = spreadId, firstBox?: string) {
    if (!template || !writable || !summary) return;
    const state = spreads.find(({ id }) => id === target);
    const definition = state && template.spreads[state.definition];
    if (!definition) return;
    const sources = keys.flatMap<SourceRef>((key) => {
      const [kind, id] = key.split(':');
      return kind === 'photo' && summary.photoIndex[id] ? [{ kind: 'photo' as const, id }] : kind === 'markdown' && summary.project.texts[id] ? [{ kind: 'text' as const, id }] : [];
    });
    const assignments = sourcePlacements(definition.boxes, state.boxes, sources, firstBox);
    if (!assignments.length) { setNotice('This spread has no empty matching boxes.'); return; }
    select(target, false);
    edit(({ project }) => {
      const spread = project.spreads.find(({ id }) => id === target);
      if (spread?.definition !== state.definition) return false;
      for (const { box, source } of assignments) spread.boxes[box] = { params: spread.boxes[box]?.params ?? {}, ...(source.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
    }, 'Placed ' + assignments.length + ' of ' + sources.length + ' assets');
  }
  const onSourceCommand = useEffectEvent((request: import('./desktop').SourceCommand) => {
    if (request.action === 'jump') select(request.spread);
    else placeSources(request.keys);
  });
  useEffect(() => {
    if (!api) return;
    const sourceCommand = api.onSourceCommand(onSourceCommand);
    const lease = api.onAgentLease(() => acquireAgentLease());
    const release = api.onAgentRelease(() => {
      agentLocked.current = false;
      if (workspace.current) workspace.current.inert = false;
      setAgentWorking(false);
    });
    const command = api.onCommand((command) => onCommand(command));
    const changed = api.onProjectChanged((change) => onProjectChanged(change));
    const progress = api.onProgress(setBusy);
    const appError = api.onAppError(setError);
    let mounted = true;
    void api.currentProject().then((result) => {
      if (!mounted || current.current) return;
      if ('error' in result) setError(result.error);
      else adopt(result.value, true);
    });
    return () => { mounted = false; sourceCommand(); command(); changed(); progress(); lease(); release(); appError(); };
  }, [api]);

  // Network origins the template declares (ADR 0006): decided once per book and template version (its hash) when it
  // first renders, and again whenever an element editor opens. Newly allowed origins reload the frames so they may
  // reach them.
  const networkAsked = useRef(new Set<string>());
  // Resolves to the project ID to render from now on.
  function decideNetwork(declared: TemplateInfo | undefined, always = false): Promise<string | void> {
    const before = current.current;
    if (!api || !before || before.readOnly || !declared?.network?.length) return Promise.resolve(before?.id);
    const key = before.folder + '\n' + (before.templateHash ?? '') + '\n' + declared.network.join(' ');
    if (!always && networkAsked.current.has(key)) return Promise.resolve(before.id);
    networkAsked.current.add(key);
    return api.editorNetwork(before.id, declared.network).then((result) => {
      if (!('value' in result) || !result.value.summary || current.current !== before) return current.current?.id;
      adopt(result.value.summary);
      return result.value.summary.id;
    });
  }

  // The book frame renders every spread, so its status doubles as the book check.
  const acceptCandidate = (id: string) => candidateId.current === id;
  function bookStatus(status: RenderStatus, id: string) {
    if (!acceptCandidate(id)) return;
    setRender(status);
    if (status.state === 'ready') {
      readyId.current = id;

      reloading.current = false;
      reloadFailed.current = false;
      setReload(undefined);
      setLastReady(status);
      setTemplate(status.template);
      void decideNetwork(status.template);
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
  // Pictures the book view draws after it is ready (ADR 0006): their failures and how many are still drawing.
  function bookPictures(pictures: PictureStatus, id: string) {
    if (!acceptCandidate(id) && readyId.current !== id) return;
    setCheck((previous) => !previous || previous.id !== id ? previous : { ...previous, pictures: pictures.pending,
      errors: [...previous.errors.filter(({ code }) => code !== 'rendered-image-failed'), ...pictures.errors] });
  }
  const checkCurrent = !!check && check.id === summary?.id;
  const spreadIssues = new Map<string, 'error' | 'warning'>();
  for (const [level, list] of [['warning', check?.warnings ?? []], ['error', check?.errors ?? []]] as const) {
    for (const { spread } of list as Issue[]) if (spread) spreadIssues.set(spread, level);
  }

  // Scrolls the book vertically so a spread is fully visible. Waits for the next layout if the spread is new.
  function reveal(id: string) {
    const sheet = geometry?.sheets.find(({ spread }) => spread === id);
    const view = canvas.current;
    if (!sheet || !view || !stage.current) {
      pendingReveal.current = id;
      return;
    }
    pendingReveal.current = undefined;
    const label = bookLayout.book.gap;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const top = stage.current.offsetTop + sheet.y;
    if (top - label >= view.scrollTop && top + sheet.height <= view.scrollTop + view.clientHeight) return;
    view.scrollTo({ top: Math.max(0, top - Math.max(label, (view.clientHeight - sheet.height) / 2)), behavior });
  }
  // The part of the book frame that is on screen, in frame coordinates, and the grid columns the frame should use. The
  // book frame loads photos near the visible part.
  function viewport() {
    const view = canvas.current;
    if (!view || !stage.current) return undefined;
    const top = view.scrollTop - stage.current.offsetTop;
    const left = view.scrollLeft - stage.current.offsetLeft;
    return { top, bottom: top + view.clientHeight, left, right: left + view.clientWidth, columns };
  }
  function measureView() {
    const range = viewport();
    if (range) {
      for (const frame of stage.current!.querySelectorAll<HTMLIFrameElement>('iframe.book-frame-book')) {
        frame.contentWindow?.postMessage({ type: 'viewport', ...range }, renderOrigin);
      }
    }
  }
  function pageMap() {
    return Object.fromEntries(spreads.map((spread, i) => [spread.id, sequence ? pageNumbers(sequence.spreads[i].page) : [i + 1]]));
  }
  function rememberViewAnchor() {
    const range = viewport();
    if (!range || !geometry || pendingAnchor.current) return;
    viewAnchor.current = captureViewAnchor(geometry.sheets, { x: range.left, y: range.top, width: range.right - range.left, height: range.bottom - range.top }, spreadId,
      Object.fromEntries(Object.entries(pageMap()).map(([id, pages]) => [id, pages[0]])));
  }
  const togglePanel: typeof togglePanelState = (side) => { preserveViewAnchor(); togglePanelState(side); };
  const showPanel: typeof showPanelState = (side) => { preserveViewAnchor(); showPanelState(side); };
  const resizePanel: typeof resizePanelState = (side, size) => { preserveViewAnchor(); resizePanelState(side, size); };
  function preserveViewAnchor() {
    if (pendingAnchor.current) return;
    rememberViewAnchor();
    pendingAnchor.current = viewAnchor.current;
  }
  useLayoutEffect(() => {
    measureView();
    if (!geometry || (geometry.columns ?? 0) !== columns) return;
    const view = canvas.current, sheetStage = stage.current;
    const nextLayout = JSON.stringify(geometry.sheets);
    const nextSize = view?.clientWidth + 'x' + view?.clientHeight;
    const changed = nextLayout !== anchorLayout.current || nextSize !== anchorSize.current;
    anchorLayout.current = nextLayout; anchorSize.current = nextSize;
    if (pendingReveal.current) {
      pendingAnchor.current = undefined;
      reveal(pendingReveal.current);
    } else if (changed && view && sheetStage) {
      const anchor = pendingAnchor.current ?? viewAnchor.current;
      const position = anchor && restoreViewAnchor(anchor, geometry.sheets, { width: view.clientWidth, height: view.clientHeight }, pageMap());
      if (position) view.scrollTo({ top: position.top + sheetStage.offsetTop, left: position.left + sheetStage.offsetLeft, behavior: 'instant' });
    }
    pendingAnchor.current = undefined;
    rememberViewAnchor();
    measureView();
  }, [geometry]);
  // A layout change asks the existing frame to reflow; its next geometry restores the same reading position.
  useEffect(() => { measureView(); }, [columns]);
  function changeLayout(next: CanvasLayout) {
    if (layout.mode === next.mode && layout.columns === next.columns) return;
    preserveViewAnchor();
    setLayout((previous) => previous.mode === next.mode && previous.columns === next.columns ? previous : next);
  }
  const onResize = useEffectEvent(() => {
    if (canvas.current?.clientWidth + 'x' + canvas.current?.clientHeight !== anchorSize.current) {
      pendingAnchor.current ??= viewAnchor.current;
      // A height-only panel change can leave the frame's width unchanged, so it may report no new geometry.
      setGeometry((current) => current && { ...current });
    }
    measureView();
  });
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
    pendingAnchor.current = undefined;
    setSpreadId(id);
    setSelectedSource(undefined);
    if (scroll) reveal(id);
  }

  function move(offset: number, id = spread?.id) {
    if (!id) return;
    // Resolve relative moves when their queued edit runs, so quick repeated presses each take one step.
    moveSpread(id, (spreads) => spreads.findIndex((spread) => spread.id === id) + offset);
  }

  function moveTo(id: string, target: number) {
    moveSpread(id, () => target, summary?.id);
  }

  function moveSpread(id: string, position: (spreads: SpreadState[]) => number, revision?: string) {
    if (!canReorder || !template) return;
    let destination = '';
    setSelectedSource(undefined);
    revealedThumb.current = '';
    edit(({ project }) => {
      // Absolute drag destinations belong to one revision; relative moves can follow earlier queued saves.
      if (revision && current.current?.id !== revision) return false;
      const target = position(project.spreads);
      const ordered = spreadOrder(project.spreads, id, target, template);
      if (!ordered) return false;
      project.spreads = ordered;
      const pages = pageSequence(ordered.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format).spreads[target].page;
      destination = pagesText(pages).toLowerCase();
    }, () => 'Spread moved to ' + destination, id);
  }

  // Starts an empty book: with one layout, or with the template's opening spreads.
  function start(layout?: string) {
    if (!template || spreads.length) return;
    const added = layout ? [newSpread(layout)] : openingSpreadStates(template);
    if (!added.length) return;
    edit(({ project }) => {
      if (project.spreads.length) return false;
      project.spreads = added;
    }, layout ? 'Added ' + (template.spreads[layout]?.label ?? layout) : "Added the template's opening spreads", added[0].id);
  }

  function add(duplicate = false, spread = spreads[index]) {
    if (!template) return;
    if (!spread) {
      if (!duplicate) start(firstSpreadLayouts(template.spreads, template.format)[0]);
      return;
    }
    // A new spread, or a new page without facing pages, uses the first layout of that footprint.
    const wanted = hasFacingPages(template.format) ? 'spread' : 'page';
    const entry = Object.entries(template.spreads).find(([, value]) => value.span === wanted);
    if (!entry && !duplicate) return;
    const next = duplicate ? { ...structuredClone(spread), id: crypto.randomUUID() } : newSpread(entry![0]);
    edit(({ project }) => {
      const position = project.spreads.findIndex(({ id }) => id === spread.id);
      // Next to the selected spread, but never before a single opening page or after a single closing page.
      const insert = template.spreads[spread.definition]?.span === 'left' ? position : position + 1;
      if (insertionProblem(project.spreads, insert, template.spreads[next.definition]?.span ?? 'spread', template)) return false;
      project.spreads.splice(insert, 0, next);
    }, undefined, next.id);
  }

  function deleteSelected(ids: string[]) {
    if (!canChangeBook || !ids.length) return;
    edit(({ project }) => { project.spreads = project.spreads.filter(({ id }) => !ids.includes(id)); }, ids.length === 1 ? 'Spread deleted' : ids.length + ' spreads deleted');
    spreadSelection.setSelection([]);
  }
  function duplicateSelected(ids: string[]) {
    if (!canChangeBook || !template) return;
    const copies = new Map(spreads.filter(({ id }) => ids.includes(id)).map((spread) => [spread.id, { ...structuredClone(spread), id: crypto.randomUUID() }]));
    const first = copies.values().next().value;
    edit(({ project }) => { project.spreads = project.spreads.flatMap((spread) => copies.has(spread.id) ? [spread, copies.get(spread.id)!] : [spread]); }, ids.length + ' spreads duplicated', first?.id);
    spreadSelection.setSelection([...copies.values()].map(({ id }) => id));
  }
  function moveSelected(ids: string[], direction: 'up' | 'down' | 'start' | 'end') {
    if (!canReorder || !template) return;
    edit(({ project }) => { const next = spreadSelectionOrder(project.spreads, ids, direction, template); if (!next) return false; project.spreads = next; }, ids.length + ' spreads moved');
  }
  async function spreadMenu(id: string, ids = spreadSelection.selected.includes(id) ? spreadSelection.selected : [id]) {
    const selected = spreads.find((spread) => spread.id === id);
    if (!selected || !api || !template) return;
    select(id, false);
    const at = spreads.indexOf(selected);
    const state: BookMenuState = { ...menuState, editing: false, enabled: {
      'add-spread': canAdd, 'delete-spread': canChangeBook,
      'duplicate-spread': canChangeBook && !ids.some((id) => hasSingleEnds(template.format) && ['left', 'right'].includes(template.spreads[spreads.find((spread) => spread.id === id)?.definition ?? '']?.span ?? '')),
      'move-spread-up': canReorder && !!spreadSelectionOrder(spreads, ids, 'up', template), 'move-spread-down': canReorder && !!spreadSelectionOrder(spreads, ids, 'down', template),
    } };
    const choices = layoutPreviews(template.spreads, selected.definition, template.layoutFamilies ?? {}, template.format, { index: at, count: spreads.length });
    const result = await api.showContextMenu(['add-spread', { command: 'duplicate-spread', label: ids.length > 1 ? 'Duplicate ' + ids.length + ' Spreads' : undefined }, 'move-spread-up', 'move-spread-down',
      'move-spread-start', 'move-spread-end', ...(choices.length > 1 && ids.length === 1 ? [{ command: 'change-layout' as const, items: choices.map((value) => ({ command: 'change-layout' as const, value, label: template.spreads[value].label, checked: value === selected.definition })) }] : []),
      { type: 'separator' }, 'presentation', ...(spreadIssues.has(id) ? [{ command: 'book-check' as const, label: 'Check This Spread' }] : []), { command: 'delete-spread', label: ids.length > 1 ? 'Delete ' + ids.length + ' Spreads' : undefined }], state);
    if (current.current?.id !== summary?.id) return;
    const command = result?.command;
    if (command === 'change-layout' && result?.value && choices.includes(result.value)) changeSpreadAt(id, (state) => { switchLayout(state, result.value!, template.spreads); }, 'Layout changed');
    else if (command === 'add-spread') add(false, selected);
    else if (command === 'duplicate-spread') { if (ids.length > 1) duplicateSelected(ids); else add(true, selected); }
    else if (command === 'delete-spread') deleteSelected(ids);
    else if (command === 'move-spread-up') moveSelected(ids, 'up');
    else if (command === 'move-spread-down') moveSelected(ids, 'down');
    else if (command === 'move-spread-start') moveSelected(ids, 'start');
    else if (command === 'move-spread-end') moveSelected(ids, 'end');
    else if (command === 'presentation') setPresenting(id);
    else if (command === 'book-check') { setCheckScope(id); setCheckRequest((value) => value + 1); }
  }
  async function canvasMenu(event: Pick<React.MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>) {
    event.preventDefault();
    const { sheet, top } = locate(event);
    if (!sheet || !summary || !template || !api) return;
    if (!top || top.type === 'element') { await spreadMenu(sheet); return; }
    select(sheet, false);
    const source = boxSource(sheet, top.id);
    const photo = top.type === 'photo';
    const items: import('./desktop').ContextMenuItem[] = photo ? ['box-replace-photo',
      { command: 'box-adjust-crop', enabled: !!source && !cropBlocked(sheet, top.id) }, { command: 'box-reset-crop', enabled: !!source }] : ['box-edit-text', 'box-replace-text'];
    if (source) items.push({ type: 'separator' }, 'asset-preview', 'box-show-assets', photo ? 'box-remove-photo' : 'box-remove-text');
    const result = await api.showContextMenu(items, { ...menuState, editing: false });
    if (!result || current.current?.id !== summary.id) return;
    switch (result.command) {
      case 'box-replace-photo': case 'box-replace-text': importFiles({ kind: photo ? 'photo' : 'markdown', target: { spread: sheet, box: top.id } }); break;
      case 'box-adjust-crop': startCrop(sheet, top.id); break;
      case 'box-reset-crop': changeSpreadAt(sheet, (spread) => { const box = spread.boxes[top.id]; if (box?.photo) setPlacement(box, spread.definition, centered); }, 'Crop reset'); break;
      case 'box-edit-text': openOwner(sheet, { type: 'markdown', id: top.id }); break;
      case 'asset-preview': if (source) setQuick(source); break;
      case 'box-show-assets': if (source) { choose(source); showPanel('bottom'); } break;
      case 'box-remove-photo': case 'box-remove-text': changeSpreadAt(sheet, (spread) => { spread.boxes[top.id] = { params: spread.boxes[top.id]?.params ?? {} }; }, photo ? 'Photo removed' : 'Text removed'); setCropping(undefined); break;
    }
  }
  function changeFormat(format: string) {
    if (!canChangeBook || !template || !Object.hasOwn(template.formats, format)) return;
    edit(({ project }) => { project.format = format; }, 'Format changed to ' + template.formats[format]);
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
  // A click as a fraction of the node it hit, which the inline editor opened from that node receives (see OpenEditor).
  function clickAt(event: { clientX: number; clientY: number; altKey: boolean }, rect: Rect) {
    const bounds = stage.current?.getBoundingClientRect();
    return bounds && rect.width > 0 && rect.height > 0
      ? { ...clickWithin(rect, event.clientX - bounds.left, event.clientY - bounds.top), alt: event.altKey } : undefined;
  }
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
    // The smallest edit target under the pointer wins, unless a smaller box sits on top of it. Of equal ones, such
    // as two elements at the same place, the one drawn on top (later in the document) wins, like `top` below.
    const area = (rect: Rect) => rect.width * rect.height;
    const target = wanted ? undefined : geometry.targets.map((rect, order) => ({ rect, order })).filter(({ rect }) => inside(rect))
      .sort((a, b) => Math.abs(area(a.rect) - area(b.rect)) < 1 ? b.order - a.order : area(a.rect) - area(b.rect))[0]?.rect;
    const element = wanted ? undefined : geometry.boxes.findLast((rect) => rect.type === 'element' && inside(rect));
    // The box or element drawn on top: geometry lists them in document order, so a later one covers an earlier
    // one (an inset map over a full-bleed photo). Templates that reorder with z-index are not accounted for.
    const top = wanted ? box : geometry.boxes.findLast((rect) => inside(rect));
    return { sheet, box, element, top, target: target && (!box || area(target) <= area(box)) ? target : undefined };
  }
  const closeEditor = useCallback(() => setEditing(undefined), []);
  // Tab moves between the edit targets of a spread in reading order.
  function stepEditor(direction: 1 | -1) {
    if (!editing || !geometry || readyId.current !== summary?.id) return;
    const order = geometry.targets.filter(({ spread }) => spread === editing.spread)
      .sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
    const at = order.findIndex((target) => targetKey(target) === editKey);
    const next = order[(at + direction + order.length) % order.length];
    if (next) openEditing({ spread: next.spread, key: targetKey(next) });
    else setEditing(undefined);
  }
  // A box or element is edited through the node it renders: its own target, found by identity (other targets can
  // share its rectangle), when it has parameters or marks; else its rectangle with nothing marked, for the
  // platform's part of the editor. One the layout leaves off the page opens at the spread's corner with its
  // declared parameters.
  function ownerTarget(spread: string, owner: Owner): Target | undefined {
    const type = owner.type === 'element' ? 'element' : 'box';
    const own = geometry?.targets.find((target) => target.spread === spread && target.owner?.type === type && target.owner.id === owner.id);
    if (own) return own;
    const rect = geometry?.boxes.find((box) => box.spread === spread && box.id === owner.id && (box.type === 'element') === (type === 'element'));
    if (rect) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, spread, edits: [], occurrence: 0, owner: { type, id: owner.id } };
    const sheet = geometry?.sheets.find((item) => item.spread === spread);
    const layout = template?.spreads[spreads.find(({ id }) => id === spread)?.definition ?? ''];
    const declared = type === 'element' ? layout?.elements[owner.id] : layout?.boxes[owner.id];
    if (!sheet || !declared) return undefined;
    return { x: sheet.x + 12, y: sheet.y + 12, width: 0, height: 0, spread, occurrence: 0, owner: { type, id: owner.id }, hidden: true,
      edits: Object.keys(declared.parameters).map((key) => (type === 'element' ? 'elements.' : 'boxes.') + owner.id + '.' + key) };
  }
  // Parameters a template marked on a box besides its own, such as a spread setting shown in its caption.
  const attachedEdits = (target: Target | undefined, owner: Owner) =>
    target?.edits.filter((path) => !path.startsWith((owner.type === 'element' ? 'elements.' : 'boxes.') + owner.id + '.')) ?? [];
  const ownerKey = (spread: string, id: string) => spread + '|#' + id;
  // A marked node is found by its key when the editor opens, and afterwards by where it was on its sheet, since a
  // re-render can shift the occurrence numbers of its field. The anchor belongs to one editor session: opening
  // another target, also by Tab, starts from its key again.
  const editAnchor = useRef<{ session: number; at: TargetAnchor }>(undefined);
  const editSheet = editing && geometry?.sheets.find(({ spread }) => spread === editing.spread);
  const editTarget: Target | undefined = editing && (editing.owner ? ownerTarget(editing.spread, editing.owner)
    : geometry && resolveTarget(geometry.targets, editing.key,
      editAnchor.current?.session === editing.session ? editAnchor.current.at : undefined, editSheet));
  // The key of the node the open editor is anchored to, for its outline and for Tab, until `editing` catches up.
  const editKey = editing && !editing.owner && editTarget ? targetKey(editTarget) : editing?.key;
  useEffect(() => {
    if (!editing || editing.owner) editAnchor.current = undefined;
    else if (editTarget && editSheet) editAnchor.current = { session: editing.session, at: targetAnchor(editTarget, editSheet) };
    // Same session, renamed to the node it is now at, so that no other node owns the key it opened with.
    if (editing && !editing.owner && editKey && editKey !== editing.key)
      setEditing((open) => open && open.session === editing.session ? { ...open, key: editKey } : open);
  }, [editing, editTarget, editSheet, editKey]);
  const editSpread = editing && spreads.find(({ id }) => id === editing.spread);
  const liveInline = summary && template && editSpread && editTarget &&
    { project: summary.project, spread: editSpread, template, target: editTarget };
  const resumeInline = !!(canvasReady && editing?.held && liveInline && inlineValues(liveInline) === inlineValues(editing.held));
  const inline = resumeInline ? liveInline : editing?.held ?? liveInline;
  const textInline = !!(editing?.text && !editing.panel && inline);
  const [textShown, setTextShown] = useState(false);
  function holdInlineEditor() {
    if (editing && !editing.held && liveInline) setEditing({ ...editing, held: liveInline });
  }
  useEffect(() => {
    if (resumeInline && readyId.current === summary?.id) setEditing((open) => open && !open.text ? { ...open, held: undefined } : open);
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
  const editPhotoBox = editOwner && geometry?.boxes.some(({ spread, id, type }) => spread === editing?.spread && id === editOwner && type === 'photo')
    ? editOwner : undefined;

  // Crop mode: the frame comes from the rendered book, the photo size and crop from the project.
  const cropFrame = cropping && geometry?.boxes.find(({ spread, id }) => spread === cropping.spread && id === cropping.box);
  const cropSheet = cropping && geometry?.sheets.find(({ spread }) => spread === cropping.spread);
  const cropState = cropping && spreads.find(({ id }) => id === cropping.spread)?.boxes[cropping.box];
  const cropPhoto = cropState?.photo;
  const cropPlacement = cropping && placementIn(cropState, cropping.layout);
  const cropBox = cropping && template?.spreads[cropping.layout]?.boxes[cropping.box];
  const cropAttached = cropping && template ? attachedEdits(ownerTarget(cropping.spread, { type: 'photo', id: cropping.box }), { type: 'photo', id: cropping.box }) : [];
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
    openEditing({ spread, key: ownerKey(spread, owner.id), owner });
  }
  // Opens the popover of a node the template marked, such as a ctx.Text heading, from the sidebar's list.
  function openTarget(target: Target, panel = false) {
    if (target.inlineText && openTextOwner(target)) return;
    if (openDocumentEditor(target)) return;
    deselectPhoto();
    select(target.spread, false);
    openEditing({ spread: target.spread, key: targetKey(target), panel });
  }
  function openTextOwner(target: Target) {
    const state = spreads.find(({ id }) => id === target.spread);
    const owner = template && state && target.edits.length === 1 && textEditorOwner(template, state.definition, target.edits[0]);
    if (!owner) return false;
    const opened = owner.kind === 'element' ? openElementEditor(target.spread, owner.element) : openDocumentEditor(target);
    if (!opened) setNotice('The book preview is updating; try again in a moment.');
    return true;
  }
  function editorOf(spread: string, element: string) {
    const state = spreads.find(({ id }) => id === spread);
    return state && template?.spreads[state.definition]?.elements[element]?.editor;
  }
  function openElementEditor(spread: string, element: string) {
    if (readyId.current !== summary?.id || !editorOf(spread, element)) return false;
    setEditing(undefined);
    deselectPhoto();
    select(spread, false);
    // Inline when the editor asks for it and the element is on the page, upright and large enough; else the panel.
    setElementEditor({ kind: 'element', spread, element,
      presentation: presentationFor(editorOf(spread, element)!.presentation, elementRect(geometry, spread, element)) });
    return true;
  }
  // A node marked only with document parameters a document editor owns opens that editor, with this spread's context.
  function openDocumentEditor(target: Target, click?: OpenEditor['click']) {
    const editor = template && documentEditorFor(template, target.edits);
    const layout = spreads.find(({ id }) => id === target.spread)?.definition;
    if (!editor || !layout || readyId.current !== summary?.id) return false;
    setEditing(undefined);
    deselectPhoto();
    select(target.spread, false);
    const presentation = target.hidden ? 'dialog' : presentationFor(template.editors?.[editor]?.presentation, target);
    setElementEditor({ kind: 'document', spread: target.spread, layout, editor, presentation,
      ...(presentation === 'inline' ? { at: targetKey(target), ...(click ? { click } : {}) } : {}) });
    return true;
  }
  // An inline document editor follows the marked node it was opened from (see anchoredTarget), and both kinds follow
  // the page as it scrolls, zooms and re-renders.
  const inlineAnchor = useRef<{ open: OpenEditor; at: TargetAnchor }>(undefined);
  const inlineTarget = elementEditor && anchoredTarget(geometry, elementEditor,
    inlineAnchor.current?.open === elementEditor ? inlineAnchor.current.at : undefined);
  const inlineSheet = elementEditor && geometry?.sheets.find(({ spread }) => spread === elementEditor.spread);
  useEffect(() => {
    if (elementEditor && inlineTarget && inlineSheet) inlineAnchor.current = { open: elementEditor, at: targetAnchor(inlineTarget, inlineSheet) };
  }, [elementEditor, inlineTarget, inlineSheet]);
  const placement = elementEditor && inlinePlacement(geometry, elementEditor, inlineTarget);
  const inlineEditing = elementEditor && inlineShown && elementEditor !== leavingEditor ? hiddenOccurrence(elementEditor, inlineTarget)
    : textInline && textShown && inline ? { spread: inline.target.spread, edits: inline.target.edits.join(' '), occurrence: inline.target.occurrence } : undefined;
  const leaveEditor = () => {
    setElementEditor((current) => current === leavingEditor ? undefined : current);
    setLeavingEditor(undefined);
  };
  useEffect(() => {
    if (!leavingEditor) return;
    const timeout = setTimeout(leaveEditor, 800);
    return () => clearTimeout(timeout);
  }, [leavingEditor]);
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
  // An editor whose spread was deleted closes, as does a document editor whose spread switched layout and so lost
  // the node it was opened from. Reordering keeps it open; its context follows.
  useEffect(() => {
    setElementEditor((open) => open && editorTargetGone(spreads, open) ? undefined : open);
  }, [spreads]);

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropTarget(undefined);
    if (event.dataTransfer.types.includes(spreadMime)) return;
    if (!api || !writable || busy || !summary || readyId.current !== summary.id) return;
    if (event.dataTransfer.types.includes(photosMime)) {
      const { sheet, box } = locate(event, event.dataTransfer.types);
      try {
        const ids: unknown = JSON.parse(event.dataTransfer.getData(photosMime));
        if (sheet && Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === 'string')) placeSources(ids.map((id) => 'photo:' + id), sheet, box?.id);
      } catch { setNotice('Could not read the selected photos.'); }
      return;
    }

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
    const kind = box?.type === 'markdown' ? 'markdown' : box?.type === 'photo' ? 'photo' : undefined;
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

  const quickItems = useMemo(() => summary && quick ? sourceList(summary, quick.kind, photoView.value) : [], [summary, quick, photoView.value]);
  function navigateQuick(step: number) {
    if (!quick) return;
    const at = quickItems.findIndex(({ id }) => id === quick.id);
    const next = quickItems[at + step];
    if (!next) return;
    const source = { kind: quick.kind, id: next.id };
    setQuick(source);
    choose(source);
  }
  const presentKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || presenting !== undefined || !event.shiftKey || event.code !== 'KeyW' || event.metaKey || event.ctrlKey ||
        controlFocused || editing || cropping || elementEditor || quick || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], iframe, dialog'))) return;
    event.preventDefault(); act(event.altKey ? 'presentation-start' : 'presentation');
  });
  useEffect(() => {
    window.addEventListener('keydown', presentKey);
    return () => window.removeEventListener('keydown', presentKey);
  }, []);
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

  function spreadDeleteKey(event: KeyboardEvent) {
    if (!['Backspace', 'Delete'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]') || !target.closest('.spread-thumb, .canvas')) return;
    if (!canDelete || editing || cropping || elementEditor || quick) return;
    event.preventDefault();
    deleteSelected(selectedSpreads);
  }

  function thumbKeys(event: KeyboardEvent<HTMLElement>) {
    spreadDeleteKey(event);
    if (event.defaultPrevented) return;
    if ((event.shiftKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')) {
      spreadSelection.key(event);
      const focused = (document.activeElement as HTMLElement)?.dataset.spread;
      if (focused) select(focused);
      return;
    }
    // The Book menu's proposed move shortcuts (#50) also work while a thumbnail has focus.
    if (event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const focused = (event.target as HTMLElement).closest<HTMLElement>('.spread-thumb')?.dataset.spread;
      if (selectedSpreads.length > 1) moveSelected(selectedSpreads, event.key === 'ArrowUp' ? 'up' : 'down');
      else if (focused) move(event.key === 'ArrowUp' ? -1 : 1, focused);
      return;
    }
    if (event.metaKey || event.altKey || event.ctrlKey) return;
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const next = step && spreads[index + step];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    thumbList.current?.querySelector<HTMLElement>('[data-spread="' + CSS.escape(next.id) + '"]')?.focus();
  }

  const usage = useMemo(() => summary ? assetUsage(summary, pageLabels) : { photo: {}, text: {} },
    [summary, template, pageLabels.join()]);
  const activeBox = dropTarget ? geometry?.boxes.find(({ spread, id }) => spread + ':' + id === dropTarget) :
    highlight ? geometry?.boxes.find(({ spread: owner, id }) => owner === spread?.id && id === highlight) : undefined;
  const selectedSheet = spreadSelected ? geometry?.sheets.find(({ spread: id }) => id === spread?.id) : undefined;
  const hoveredSheet = hovered !== spread?.id ? geometry?.sheets.find(({ spread: id }) => id === hovered) : undefined;
  const previewError = typeof reload === 'object' ? reload.error : render?.state === 'error' ? render.message : '';
  const issue = previewError || error;
  const previewNotice = agentWorking ? 'Agent is updating the book…' : previewError ? (geometry ? 'Showing the last successful preview' : 'Book preview unavailable') : '';
  const blockedInline = editing?.held && !resumeInline && (canvasReady
    ? 'This field changed while you were editing. Close it and open the field again to continue.'
    : 'Editing is paused while the preview is out of date.');
  const canExport = canvasReady && !busy && spreads.length > 0;
  const menuState: BookMenuState = { importMode: summary?.project.importMode, document: !!summary, enabled: { 'add-spread': canAdd, 'duplicate-spread': canDuplicate,
    'move-spread-up': canMoveUp, 'move-spread-down': canMoveDown, 'delete-spread': canDelete && spreadFocused },
    editing: controlFocused || !!editing || !!cropping || !!elementEditor || !!quick, textEditing,
    writable, busy: !!busy || exporting || !!reload || agentWorking, history: summary?.history,
    canExport, canPrint: canExport && checkCurrent && !check?.errors.length,
    sidebar: !panels.leftHidden, inspector: !panels.rightHidden, sources: !panels.bottomHidden, guides: showGuides, layout, zoom, selectedSpread: spreadId, photoView: photoView.value, selectionCount: selectedSpreads.length,
    saving, pageLabels: Object.fromEntries(spreads.map(({ id }, i) => [id, pageLabels[i]])) };
  const menuKey = JSON.stringify(menuState);
  useEffect(() => { void api?.setBookMenuState(menuState); }, [api, menuKey]);
  const undoCommand = commandState('undo', menuState), redoCommand = commandState('redo', menuState);
  const pdfCommand = commandState('export', menuState), printCommand = commandState('print', menuState);

  const counts = summary ? assignmentCounts(summary.project, template?.spreads) : {};
  const format = formatOf(template);
  // A saved format the template's named formats no longer include; the Book check reports it and print export is
  // blocked. A template with one fixed format offers no choices and ignores the saved one.
  const missingFormat = !!template && Object.keys(template.formats).length > 0 && !!summary?.project.format &&
    !Object.hasOwn(template.formats, summary.project.format);
  const label = (definition: string, i: number) => template?.spreads[definition]?.label ?? 'Spread ' + (i + 1);
  const pagesLabel = (i: number) => (pageLabels[i].includes('–') ? 'Pages ' : 'Page ') + pageLabels[i];

  return <ProjectFilesContext.Provider value={projectFiles}><div className={navigator.platform.includes('Mac') ? 'studio mac-studio' : 'studio'}>
    <div className="editor-shell" inert={presenting !== undefined} aria-hidden={presenting !== undefined}>
    <header className="toolbar">
      <div className="toolbar-actions project-context">
        <button className="toolbar-icon" aria-label="Toggle project panel" aria-pressed={!panels.leftHidden} title="Toggle project panel (⌃⌘S)" onClick={() => togglePanel('left')}><Icon name="sidebarLeft" /></button>
        <div className="project-identity" title={summary?.folder}
          onContextMenu={(event) => { event.preventDefault(); void api?.documentProxy('path'); }}
          onClick={(event) => { if (event.metaKey) void api?.documentProxy('path'); }}>
          {summary && <button type="button" className="document-proxy" aria-label="Document location" title="⌘-click for location · Drag to Finder"
            draggable onDragStart={(event) => { event.preventDefault(); void api?.documentProxy('drag'); }}
            onClick={(event) => { event.stopPropagation(); void api?.documentProxy('path'); }}><Icon name="book" size={14} /></button>}
          <span className="document-title">{summary ? bookName(summary.folder) : 'ImageFlow'}</span>
          <span className="muted">{summary?.readOnly ? 'Read Only' : ''}</span>
        </div>
        {summary && <div className="history">
          <button aria-label="Undo" title={undoCommand.label} disabled={!undoCommand.enabled} onClick={() => undo('undo')}><Icon name="undo" /></button>
          <button aria-label="Redo" title={redoCommand.label} disabled={!redoCommand.enabled} onClick={() => undo('redo')}><Icon name="redo" /></button>
        </div>}
      </div>
      <div className="toolbar-actions">
        <button className="toolbar-icon" aria-label="Presentation" title="Presentation (⇧W)" disabled={!summary || !!editing || !!cropping} onClick={() => act('presentation')}><Icon name="play" /></button>
        <div className="export-area">
          {exporting ? <div className="export-progress"><span role="status" title={busy}>{busy}</span><button onClick={() => void api?.cancelExport()}>Cancel export</button></div> : <ActionMenu className="export-menu" disabled={!summary} label={<><Icon name="export" /><span>Export</span><Icon name="chevron" /></>}>
            <div className="export-choices">
              <button className="primary" disabled={!printCommand.enabled} title={!checkCurrent ? 'Checking book…' : check?.errors.length ? 'Resolve book check errors' : undefined} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); act('print'); }}>Export for Print…</button>
              <button disabled={!pdfCommand.enabled} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); act('export'); }}>Export PDF…</button>
            </div>
          </ActionMenu>}
        </div>
        <button className="toolbar-icon" aria-label="Toggle Inspector" aria-pressed={!panels.rightHidden} title="Toggle Inspector (⌥⌘I)" disabled={!summary} onClick={() => togglePanel('right')}><Icon name="sidebarRight" /></button>
      </div>
    </header>
    <div ref={workspace} inert={agentWorking} key={projectInstance} className="workspace"
      data-resizing={resizing || undefined}
      style={{ '--left-content': panels.left + 'px', '--right-content': panels.right + 'px', '--left-panel': panels.leftHidden ? '0px' : panels.left + 'px', '--right-panel': panels.rightHidden ? '0px' : panels.right + 'px',
        '--bottom-panel': panels.bottomHidden ? '0px' : panels.bottom + 'px', '--bottom-divider': panels.bottomHidden ? '0px' : '6px',
        '--left-divider': panels.leftHidden ? '0px' : '6px', '--right-divider': panels.rightHidden ? '0px' : '6px' } as CSSProperties}>
      <aside className={'project-panel' + (panels.leftHidden ? ' is-collapsed' : '')} aria-label="Project" inert={panels.leftHidden} aria-hidden={panels.leftHidden}>
        <div className="project-panel-content">
        <div className="project-head">

          <p className="muted" title={summary?.folder}>{summary ? (sequence ? sequence.count + ' pages · ' + spreads.length + ' spreads' : 'Loading book…') : ''}</p>
        </div>
        {summary && template && <details className="document-settings template-controls">
          <summary>{template.label ? template.label + ' settings' : 'Template controls'}</summary>
          <fieldset disabled={!writable}>
            {(Object.keys(template.formats).length > 1 || missingFormat) && <label className="field">Format
              <select value={missingFormat ? summary.project.format : template.formatId} onChange={(event) => {
                changeFormat(event.target.value);
              }}>
                {missingFormat && <option value={summary.project.format} disabled>{summary.project.format} (not in the template)</option>}
                {Object.entries(template.formats).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select></label>}
            <Fields schema={template.parameters} values={summary.project.params} controls={template.controls} exclude={editorOwnedDocument(template)}
              update={(id, value) => edit(({ project }) => { project.params[id] = value; })} />

          </fieldset>
        </details>}
        {summary && <>
          <div className="spread-bar">
            <span className="eyebrow">Spreads</span>
            <div className="icon-actions">
              <button aria-label="Add" title="Add spread" disabled={!canAdd} onClick={() => add()}><Icon name="add" /></button>
            </div>
          </div>
          <div className="thumbs-scroll" onDragOver={reorder.over} onDragLeave={reorder.leave} onDrop={reorder.drop}>
            <div ref={thumbList} className={thumbs ? 'spread-thumbs placed' : 'spread-thumbs'} style={{ height: thumbs?.height }}
              role="group" aria-label="Spreads" onKeyDown={thumbKeys}>
              {spreads.map(({ id, definition }, i) => {
                const rect = thumbs?.sheets.find(({ spread }) => spread === id);
                const level = spreadIssues.get(id);
                return <button key={id} data-list-id={id} data-spread={id}
                  aria-pressed={spreadSelected && selectedSpreads.includes(id)} aria-current={spreadSelected && index === i ? 'page' : undefined} aria-label={label(definition, i) + ' ' + pageLabels[i]}
                  title={pagesLabel(i) + ' · ' + label(definition, i) + (level ? ' · ' + (level === 'error' ? 'Has errors' : 'Has warnings') : '')}
                  className={'spread-thumb' + (reorder.dragging === id ? ' reordering' : '')} tabIndex={index === i ? 0 : -1}
                  draggable={selectedSpreads.length <= 1 && canReorder && (canMoveSpread(id, i - 1) || canMoveSpread(id, i + 1))}
                  onDragStart={(event) => reorder.start(event, id)} onDragEnd={reorder.end}
                  style={rect ? { left: rect.x - 5, top: rect.y - 5, width: rect.width + 10, height: rect.height + 30 } : undefined}
                  onContextMenu={(event) => { const ids = spreadSelection.context(id, event); void spreadMenu(id, ids); }}
                  onKeyDown={(event) => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void spreadMenu(id); }
                  }} onClick={(event) => { spreadSelection.choose(id, event); select(id); }}>
                  <span className="spread-thumb-label">
                    {level && <span className={'issue-dot issue-' + level} />}
                    <span className="pages">{pageLabels[i]}</span>
                    <span className="name">{label(definition, i)}</span>
                  </span>
                </button>;
              })}
              {reorder.indicator && <div className="spread-insertion" aria-hidden="true" style={{ top: reorder.indicator.top }} />}
              <BookFrame project={summary.id} view="thumbs" title="Spread thumbnails" onGeometry={setThumbs}
                hold={holdPreview} accept={acceptCandidate} />
            </div>
          </div>
        </>}
        </div>
      </aside>
      {!panels.leftHidden ? <PanelDivider side="left" size={panels.left} resize={resizePanel} onResizing={setResizing} /> : <div />}
      <div className="workspace-center">
        <div ref={canvasWrap} className="canvas-wrap">
          <main ref={canvas} className={'canvas' + (geometry?.columns ? ' canvas-grid' : '')} aria-label="Book preview" tabIndex={0} onWheel={() => { pendingAnchor.current = undefined; }} onScroll={() => { rememberViewAnchor(); measureView(); }}
            onContextMenu={(event) => void canvasMenu(event)} onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void spreadMenu(spreadId); } else spreadDeleteKey(event);
            }} onPointerDown={(event) => {
              if (!(event.target as HTMLElement).closest('input, textarea, select, button, [contenteditable]')) event.currentTarget.focus({ preventScroll: true });
            }}
            onDragOver={(event) => {
              if (!writable || !canvasReady || !event.dataTransfer.types.some((type) => type === 'Files' || type === photoMime || type === textMime)) return;
              event.preventDefault();
              const { box } = locate(event, event.dataTransfer.types);
              setDropTarget(box ? box.spread + ':' + box.id : undefined);
            }} onDragLeave={() => setDropTarget(undefined)} onDrop={drop}>
            {summary && !spreads.length && <EmptyBook template={template} writable={writable && !busy} start={start} />}
            {summary && <div ref={stage} className="stage"
              // A grid fills the canvas width; the frame reports the height of all its rows.
              style={{ width: zoom !== 1 ? (zoom * 100) + '%' : columns ? '100%' : undefined, height: geometry?.height,
                cursor: hoveredTarget ? 'pointer' : undefined,
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
                  (target.owner?.id === top.id && (target.owner.type === 'element') === (top.type === 'element'))));
                if (target?.inlineText) openTarget(target);
                else if (top && own) openOwner(top.spread, { type: top.type, id: top.id });
                else if (target && !openDocumentEditor(target, clickAt(event, target))) openEditing({ spread: target.spread, key: targetKey(target) });
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
              <BookFrame project={summary.id} view="book" title="Book preview" cropPreview={cropPreview} onGeometry={setGeometry} onStatus={bookStatus} onPictures={bookPictures}
                viewport={viewport} hold={holdPreview} accept={acceptCandidate} inlineEditing={inlineEditing}
                onInlineEditing={(key) => { if (leavingEditor && key === 'null') leaveEditor(); }} />
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
                return !cropping && (key === hoveredTarget || key === editKey);
              }).map((target) => <div key={targetKey(target)} aria-hidden="true"
                className={'edit-target' + (targetKey(target) === editKey ? ' active' : '')}
                style={{ left: target.x - 4, top: target.y - 3, width: target.width + 8, height: target.height + 6 }} />)}
              {moving && summary?.photos[moving.photo] && <img className="photo-move-ghost" src={summary.photos[moving.photo]} alt=""
                style={{ left: moving.x, top: moving.y }} />}
              {cropping && cropFrame && cropPhoto && summary && <CropEditor key={cropping.spread + ':' + cropping.box}
                frame={cropFrame} photo={summary.photoSizes[cropPhoto]} src={renderOrigin + '/render/' + summary.id + '/photo/' + cropPhoto}
                placement={cropPlacement} settling={!!cropping.settling}
                inchesPerPixel={format && cropSheet ? format.spreadWidth / cropSheet.width / 25.4 : undefined}
                resolution={template?.format.output.resolution} save={saveCrop} close={deselectPhoto}
                custom={!!cropFrame.custom} preview={(placement) => setCropPreview(placement && { spread: cropping.spread, box: cropping.box, placement })}
                toolbarHost={canvasWrap.current}>
                {/* The box's photo and its own parameters (such as Show caption) sit with the selected photo. Replacing or
                    removing the photo ends the selection. */}
                {cropState && summary && <div className="crop-params crop-content">
                  <PhotoContent summary={summary} spread={spreads.find(({ id }) => id === cropping.spread)!} box={cropping.box} compact values
                    label={cropBox?.label ?? cropping.box} assigned={deselectPhoto}
                    change={(update, notice) => changeSpreadAt(cropping.spread, update, notice)} />
                </div>}
                {cropBox && Object.keys(cropBox.parameters).length > 0 && <div className="crop-params">
                  <Fields compact schema={cropBox.parameters} controls={cropBox.controls} values={cropState?.params ?? {}} update={(key, value) => edit(({ project }) => {
                    const state = project.spreads.find(({ id }) => id === cropping.spread);
                    if (state?.definition !== cropping.layout || state.boxes[cropping.box]?.photo !== cropPhoto) return;
                    state.boxes[cropping.box].params[key] = value;
                  }, cropBox.parameters[key].label + ' updated')} />
                </div>}
                {cropAttached.length > 0 && <div className="crop-params">
                  <MarkedFields compact project={summary.project} spread={spreads.find(({ id }) => id === cropping.spread)!} template={template!}
                    edits={cropAttached} edit={(change, notice) => edit((files) => {
                      if (files.project.spreads.find(({ id }) => id === cropping.spread)?.definition === cropping.layout) change(files);
                    }, notice)} />
                </div>}
              </CropEditor>}
              {editing && inline && summary && textInline && <InlineTextEditor key={editing.session}
                projectId={summary.id} project={summary.project} spread={editSpread ?? { ...inline.spread, definition: '' }} template={template ?? inline.template} target={inline.target}
                zoom={editSheet?.zoom ?? 1} host={canvasWrap.current} canvasReady={canvasReady} blocked={blockedInline || undefined}
                readOnly={summary.readOnly} edit={edit} close={closeEditor} step={stepEditor} shown={setTextShown} notice={setNotice} />}
              {editing && inline && summary && !textInline && <EditPopover key={editing.session}
                compact={editing.owner?.type === 'markdown'} anchor={() => {
                  const stageRect = stage.current?.getBoundingClientRect(), host = canvasWrap.current?.getBoundingClientRect();
                  return stageRect && host ? { x: stageRect.left - host.left + inline.target.x, y: stageRect.top - host.top + inline.target.y, width: inline.target.width, height: inline.target.height } : undefined;
                }} project={inline.project} spread={inline.spread} template={inline.template} edits={inline.target.edits} host={canvasWrap.current}
                textFallback={inline.target.textFallback}
                readOnly={summary.readOnly} blocked={blockedInline || undefined}
                edit={editInline} close={closeEditor} step={stepEditor} title={editing.owner && ownerLabel(inline.spread, editing.owner)}
                actions={!editing.owner && editPhotoBox && !cropBlocked(editing.spread, editPhotoBox)
                  ? <button type="button" onClick={() => startCrop(editing.spread, editPhotoBox)}>Adjust crop…</button>
                  : editElement && editorOf(editing.spread, editElement)
                    ? <button type="button" onClick={() => openElementEditor(editing.spread, editElement)}>
                      {(editorOf(editing.spread, editElement)!.label ?? 'Open editor') + '…'}</button> : undefined}>

                {editing.owner?.type === 'photo' && <PhotoContent summary={summary} spread={inline.spread} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose} values={!!boxSource(editing.spread, editing.owner.id)}
                  adjustCrop={cropBlocked(editing.spread, editing.owner.id) ? undefined : () => startCrop(editing.spread, editing.owner!.id)} />}
                {editing.owner?.type === 'markdown' && <TextContent compact quickLook={setQuick} summary={summary} spread={inline.spread} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose}
                  flow={readyFlow?.[editing.spread + ':' + editing.owner.id]}
                  importText={() => importFiles({ kind: 'markdown', target: { spread: editing.spread, box: editing.owner!.id } })} />}
              </EditPopover>}
            </div>}
            {!summary && <p className="book-loading" role="status">{error || 'Opening book…'}</p>}
          </main>
          {summary && previewNotice && <div className={geometry ? 'preview-state' : 'preview-message'} role="status">{previewNotice}</div>}
        </div>
        {summary && (!panels.bottomHidden ? <PanelDivider side="bottom" size={panels.bottom} maximum={bottomMaximum} resize={resizePanel} onResizing={setResizing} /> : <div />)}
        <div className="sources-host" inert={panels.bottomHidden} aria-hidden={panels.bottomHidden}>
        {summary && <Sources view={photoView} summary={summary} tab={sourceTab} setTab={setSourceTab}
          selected={selectedSource ? { [selectedSource.kind]: selectedSource.id } : {}} choose={choose}
          failure={setError} changed={(next) => adopt(next)} usage={usage} writable={writable} busy={!!busy} importSources={act} quickLook={setQuick}
          importPaths={(files) => {
            const paths = api?.pathsForFiles(files) ?? [];
            if (paths.length) importFiles({ paths });
          }} />}
        </div>
      </div>
      {summary && (!panels.rightHidden ? <PanelDivider side="right" size={panels.right} resize={resizePanel} onResizing={setResizing} /> : <div />)}
      <div className={'inspector-host' + (panels.rightHidden ? ' is-collapsed' : '')} inert={panels.rightHidden} aria-hidden={panels.rightHidden || !summary}>
    {summary && spread && <Inspector summary={writable || summary.readOnly ? summary : { ...summary, readOnly: true }}
        spread={spread} source={selectedSource} template={template} render={render ?? lastReady}
        usage={usage} quickLook={() => selectedSource && setQuick(selectedSource)} focus={focusBox}
        targets={geometry?.targets.filter((target) => target.spread === spread.id)}
        open={(owner) => { reveal(spread.id); openOwner(spread.id, owner); }}
        openTarget={(target) => { reveal(spread.id); openTarget(target, true); }} place={(from, to) => place(spread.id, from, to)}
        familyPicker={template && layoutFamily && <LayoutFamilyPicker
          key={JSON.stringify([summary.handle, spread.id, layoutFamily, summary.templateHash, template.format, summary.network])}
          project={summary.id} template={template} spread={spread} params={summary.project.params} family={layoutFamily}
          readOnly={!writable} blocked={previewNotice || undefined} edit={edit} />}
        edit={edit} highlight={setHighlight} issues={issue} select={select} />}
      </div>
    </div>
    {summary && template && elementEditor && !editorTargetGone(spreads, elementEditor) &&
      <ElementEditorDialog host={canvasWrap.current} key={JSON.stringify(elementEditor)} project={summary.id} template={template}
        presentation={elementEditor.presentation} placement={placement} click={elementEditor.click} stage={stage.current} shown={setInlineShown}
        spread={spreads.find(({ id }) => id === elementEditor.spread)!} params={summary.project.params} target={elementEditor} readOnly={summary.readOnly}
        blocked={agentWorking ? 'Agent is updating the book…' : reloading.current ? 'Editing is paused while the book reloads…' : previewError || undefined}
        canvasReady={canvasReady} geometry={geometry} edit={edit} close={() => {
          if (elementEditor.presentation === 'inline' && inlineShown) setLeavingEditor(elementEditor);
          else setElementEditor((current) => current === elementEditor ? undefined : current);
        }} importFile={importProjectFile}
          prepare={template?.network?.length ? () => decideNetwork(template, true) : undefined} network={summary.network?.join(' ')} />}
    {summary && quick && <QuickLook view={photoView.value} summary={summary} source={quick} usage={usage} navigate={navigateQuick}
      close={() => setQuick(undefined)} jump={(id) => select(id)} />}
    {photoView.dialog}
    <footer className="status-bar">
      <span title={issue || busy || notice || undefined} className={issue ? 'status status-error' : 'status'} role={issue && !summary ? 'alert' : 'status'}>
        {issue || busy || notice}
      </span>
      <AgentStatus api={api} />
      {summary && <BookCheckIndicator requestSpread={checkScope} request={checkRequest} check={check} checking={!checkCurrent} spread={spreadSelected ? spread?.id ?? '' : ''} select={select} />}
    </footer>
    </div>
    {summary && template && presenting !== undefined && <Presentation summary={summary} template={template} start={presenting} close={(id) => {
      setPresenting(undefined); select(id); canvas.current?.focus({ preventScroll: true });
    }} />}
  </div></ProjectFilesContext.Provider>;
}
