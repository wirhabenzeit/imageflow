import { useCanvasGestures } from './useCanvasGestures';
import { useDelayed } from './useDelayed';
import { pageSelectionRect, pageSelectionSide, pageSideAt, stepPageSelection } from './page-selection';
import { canSwapPages, editableSpread, keptItems, layoutMime, placeKeptContent, shownContentTargets } from './page-editor';
import type { ContentTarget, KeptItem } from './page-editor';
import { scopeSpread } from './project';
import type { PageSide } from './project';
import { layoutFootprint, shownLayoutStates } from './layouts';
import { CanvasHover } from './CanvasHover';
import { inspectorTargets } from './inspector-targets';
import type { InspectorTarget } from './inspector-targets';
import { useLiveCallback } from './useLiveCallback';
import { usePhotoView } from './PhotoViewMenu';
import { isPhotoViewCommand } from './photo-view';
import { captureViewAnchor, restoreViewAnchor, scaleBookGeometry } from './view-anchor';
import type { ViewAnchor } from './view-anchor';
import { assetUsage, fileExtensions } from './asset-usage';
import { sourcePlacements } from './source-placement';
import { importFeedback } from './import-feedback';
import { commandState } from './commands';
import type { ActiveBookEditor, BookMenuState } from './desktop';
import { bookName } from './book-name';
import type { ImportMode } from './source-locations';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import { bookLayout, gridColumns, isRenderOrigin, renderOrigin, spreadCommands, thumbsOrigin } from './desktop';
import { resolveTarget, targetAnchor, targetKey } from './edit-targets';
import type { TargetAnchor } from './edit-targets';
import type { BookGeometry, CanvasLayout, Command, ImportRequest, Issue, ProjectChange, ProjectSummary, Rect, RenderStatus, TemplateInfo } from './desktop';
import { PanelDivider, useCanvasLayout, usePanels, useSectionOpen } from './panels';
import { PanelSection } from './PanelSection';
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
import { minimumText, textEditorOwner, textExtent, textFits } from './inline-text';
import { PhotoContent, TextContent } from './BoxContent';
import { ProjectFilesContext } from './Fields';
import { centered, getCrop, placementIn, placementOf, setPlacement } from './spread';
import type { Placement } from './spread';
import { continuedSpread, editorLayoutsAt, firstEditorLayouts, newEditorSpread, openingSpreadStates, readEdit, resolveEditPath } from './editing';
import { describeLayoutChange, editorLayoutChoices, editorLayoutPreviews, editorLayoutTarget, pickerFamily, swapContent, sheetLayoutLabel, swapPages, switchLayout } from './layouts';
import { Fields } from './Fields';
import { Inspector } from './Inspector';
import type { Edit } from './Inspector';
import { BookCheckIndicator } from './BookCheck';
import type { PictureStatus } from './BookFrame';
import type { BookCheck } from './BookCheck';
import { QuickLook, Sources } from './Sources';
import { keptMime, photosMime, photoMime, sourceList, sourceTitle, textMime } from './source-items';
import type { SourceKind, SourceRef, SourcesTab } from './source-items';
import { hasFacingPages, hasSingleEnds, pageNumbers, pageLabel, pageSequence, pagesText, resolveFormat, sheetPages } from './format';
import type { ResolvedFormat } from './format';
import type { ProjectFiles, SpreadState } from './project';
import { useListSelection } from './list-selection';
import { insertionProblem, spreadOrder, spreadSelectionOrder } from './spread-order';
import { spreadMime, useSpreadReorder } from './useSpreadReorder';
import { animateReorder, reorderOffsets, reorderTiming } from './reorder-motion';
import { useToolbarDrag } from './useToolbarDrag';

type Owner = { page?: PageSide; type: 'photo' | 'markdown' | 'element'; id: string };
// `hidden`: the box or element is declared but not on the page, so the editor opens at the spread's corner.
type Target = BookGeometry['targets'][number] & { hidden?: boolean };
type InlineContext = {
  project: ProjectFiles['project']; spread: SpreadState; template: TemplateInfo; target: Target;
};

function inlineValues({ project, spread, template, target }: InlineContext) {
  return JSON.stringify([spread.split, scopeSpread(spread, target.page)?.definition, target.edits.map((path) => {
    const field = resolveEditPath(template, scopeSpread(spread, target.page)?.definition ?? '', path, target.page);
    return [field, field && readEdit(project, spread, field)];
  })]);
}

const isGridColumns = (command: Command): command is `grid-columns-${typeof gridColumns[number]}` =>
  gridColumns.some((count) => command === `grid-columns-${count}`);

// The editor shell must survive a template whose format cannot be resolved; the render reports why.
// A focused form field or rich text, or any control inside an open dialog, may hold an edit that is not saved yet, so
// it blocks agent saves. Returns the name the agent is told to finish, or undefined when focus blocks nothing.
function focusedEditorLabel(node: Element | null): string | undefined {
  if (!(node instanceof HTMLElement)) return;
  const dialog = node.closest('dialog');
  if (dialog) {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const name = dialog.getAttribute('aria-label') || (labelledBy && document.getElementById(labelledBy)?.textContent?.trim())
      || dialog.querySelector('h1, h2, h3')?.textContent?.trim();
    return name ? name + ' dialog' : 'open dialog';
  }
  if (!node.matches('input, textarea, select, [contenteditable="true"]')) return;
  const labels = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement ? node.labels : null;
  return node.getAttribute('aria-label') || labels?.[0]?.textContent?.trim() || 'focused editor control';
}

function formatOf(template?: TemplateInfo) {
  try {
    return template && resolveFormat(template.format);
  } catch {
    return undefined;
  }
}

function Guides({ sheet, format }: { sheet: Rect & { spread: string }; format: ResolvedFormat }) {
  const { trim, bleed, safe, spreadWidth, height } = format;
  const x = sheet.width / spreadWidth;
  const y = sheet.height / height;
  const pages = sheetPages(format);
  return <div data-canvas-spread={sheet.spread} className="guides" aria-hidden="true" style={{ left: sheet.x, top: sheet.y, width: sheet.width, height: sheet.height }}>
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
  const layouts = template ? firstEditorLayouts(template.spreads, template.format) : [];
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
  // Settings → Faster book updates: the book view and thumbnails render each edit in place (#210).
  const [fasterUpdates, setFasterUpdates] = useState(true);
  useEffect(() => {
    if (!api) return;
    void api.getSettings().then((result) => { if ('value' in result && result.value) setFasterUpdates(result.value.fasterBookUpdates !== false); });
    return api.onSettingsChanged((settings) => setFasterUpdates(settings.fasterBookUpdates !== false));
  }, [api]);
  const [resizing, setResizing] = useState(false);
  const { panels, bottomMaximum, toggle: togglePanelState, show: showPanelState, resize: resizePanelState } = usePanels(resizing);
  const [summary, setSummary] = useState<ProjectSummary>();
  useEffect(() => { if (summary) document.title = bookName(summary.folder); }, [summary?.folder]);
  const photoView = usePhotoView(summary?.viewKey ?? summary?.folder);
  const [projectInstance, setProjectInstance] = useState(0);
  const current = useRef<ProjectSummary>(undefined);
  const [spreadId, setSpreadId] = useState('');
  const [selectedSide, setSelectedSide] = useState<PageSide>();
  useToolbarDrag();
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
  const [fittedGeometry, setGeometry] = useState<BookGeometry>();
  const [preparedViews, setPreparedViews] = useState<{ project: string; book?: boolean; thumbs?: boolean; start?: number }>();
  // A view that showed a revision before the views were paired (the thumbnails render in their own process and can be
  // first) counts as prepared for it: otherwise the other view waits for it forever.
  function preparedView(project: string, view: 'book' | 'thumbs') {
    const start = performance.timeOrigin + performance.now();
    setPreparedViews(previous => {
      if (previous?.project === project && previous[view]) return previous;
      const next = { ...(previous?.project === project ? previous : { project }), [view]: true };
      if (next.book && next.thumbs) next.start = start;
      return next;
    });
  }
  const frameRelease = useMemo(() => preparedViews?.start === undefined ? undefined :
    { project: preparedViews.project, start: preparedViews.start }, [preparedViews]);
  const [canvasLabels, setCanvasLabels] = useState<Record<string, string>>({});
  const [canvasMotion, setCanvasMotion] = useState<{ offsets: ReturnType<typeof reorderOffsets>; start: number }>();
  function setCanvasGeometry(next: BookGeometry | undefined, animate = false, start?: number, revision?: string) {
    setCanvasMotion(animate && start ? { offsets: reorderOffsets(geometry, next && scaleBookGeometry(next, zoom)), start } : undefined);
    setGeometry(next);
    // Resize messages from the old displayed frame must not adopt the pending revision's labels. Geometry can arrive
    // before the template, which has no page numbers or layout names yet; the live labels stand in until it does,
    // and the effect below takes the snapshot when it arrives.
    if (revision) shownRevision.current = revision;
    if (revision === summary?.id && template) adoptCanvasLabels();
  }
  const shownRevision = useRef<string>(undefined);
  const adoptCanvasLabels = () => setCanvasLabels(Object.fromEntries(spreads.map(({ id }, i) => [id, pagesLabel(i) + ' · ' + label(i)])));
  // A book's first frame usually shows before its template loads. Without this, its labels would keep following the
  // live book, and the first edit would relabel the old artwork before the new frame shows.
  useEffect(() => {
    if (template && summary && shownRevision.current === summary.id) adoptCanvasLabels();
  }, [template]);
  const [thumbnailState, setThumbnailState] = useState<{ geometry?: BookGeometry; animate: boolean; start?: number }>({ animate: true });
  const thumbs = thumbnailState.geometry;
  // Each view can first appear on its own. Once both show artwork, release replacement frames together.
  const pairFrames = Boolean(fittedGeometry && thumbs);
  function setThumbs(geometry: BookGeometry | undefined, animate = true, start?: number) {
    setThumbnailState({ geometry, animate, start });
  }
  const [hoverEpoch, setHoverEpoch] = useState(0);
  // The inline editor that is open: for a marked node (a target), or for a box or element itself (`owner`).
  // `session` names one opening of an editor: it stays while the node the editor is anchored to is renamed (`key`), so
  // the popover and its unsaved drafts are kept, and changes when the user opens another target.
  const [editing, setEditing] = useState<{ page?: PageSide; spread: string; key: string; session: number; held?: InlineContext; owner?: Owner; panel?: boolean; text?: boolean }>();
  const editorSessions = useRef(0);
  const openEditing = (next: { page?: PageSide; spread: string; key: string; owner?: Owner; panel?: boolean }) => {
    const target = geometry?.targets.find((item) => targetKey(item) === next.key);
    if (target?.inlineText && openTextOwner(target)) return;
    const state = summary?.project.spreads.find(({ id }) => id === next.spread);
    const text = !!(!next.owner && !next.panel && canvasReady && readyId.current === summary?.id && target && textFits(target));
    setEditing({ ...next, page: next.page ?? next.owner?.page ?? target?.page, session: ++editorSessions.current, text,
      ...(text && summary && template && state && target ? { held: { project: summary.project, spread: state, template, target } } : {}) });
  };
  // Crop mode for one photo box. After a commit, `settling` holds the project id the edit started from; the
  // overlay stays until the book has re-rendered, so the frame does not flash back to the old crop.
  // The selected photo, whose crop drags and pinches adjust. `layout` is the spread's layout when it was selected:
  // each layout has its own crop. `saved` holds the project id the last crop edit started from; after the photo is
  // deselected, `settling` keeps its overlay until the book has re-rendered, so the frame does not flash back.
  const [cropping, setCropping] = useState<{ page?: PageSide; spread: string; box: string; layout: string; saved?: string; settling?: string }>();
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
  const [sourceTab, setSourceTab] = useState<SourcesTab>('photo');
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
  const geometry = useMemo(() => fittedGeometry && scaleBookGeometry(fittedGeometry, zoom), [fittedGeometry, zoom]);
  const liveZoom = useRef(1);
  const fitAnchor = useRef<ViewAnchor>(undefined);
  const pinchAnchor = useRef<ViewAnchor>(undefined);
  function setZoom(next: number | ((value: number) => number), pinch?: { x: number; y: number; start: boolean }) {
    const previous = liveZoom.current;
    const value = Math.max(.3, Math.min(3, typeof next === 'function' ? next(previous) : next));
    if (!Number.isFinite(value)) return;
    if (pinch && (pinch.start || !pinchAnchor.current)) {
      const range = viewport();
      const bounds = canvas.current?.getBoundingClientRect();
      pinchAnchor.current = range && bounds && geometry ? captureViewAnchor(geometry.sheets,
        { x: range.left, y: range.top, width: range.right - range.left, height: range.bottom - range.top }, spreadId, {},
        { x: range.left + pinch.x - bounds.left, y: range.top + pinch.y - bounds.top }) : undefined;
    } else if (!pinch) pinchAnchor.current = undefined;
    if (value === previous) return;
    if (previous === 1 && (!pinch || pinch.start || !fitAnchor.current)) {
      rememberViewAnchor();
      fitAnchor.current = viewAnchor.current;
    }
    if (value === 1 && !pinch && fitAnchor.current) {
      pendingAnchor.current = fitAnchor.current;
      fitAnchor.current = undefined;
    } else if (pinch && pinchAnchor.current) pendingAnchor.current = pinchAnchor.current;
    else preserveViewAnchor();
    liveZoom.current = value;
    setZoomState(value);
  }
  const [textEditing, setTextEditing] = useState(false);
  const [checkRequest, setCheckRequest] = useState(0);
  const [checkScope, setCheckScope] = useState<string>();
  const [controlFocused, setControlFocused] = useState(false);
  const [focusedEditor, setFocusedEditor] = useState<string>();
  const [spreadFocused, setSpreadFocused] = useState(false);
  useEffect(() => {
    const focus = () => setSpreadFocused(!!document.activeElement?.closest('.spread-thumb, .canvas'));
    const pointer = (event: PointerEvent) => setSpreadFocused(event.target instanceof Element && !!event.target.closest('.spread-thumb, .canvas'));
    document.addEventListener('focusin', focus); document.addEventListener('pointerdown', pointer, true);
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('pointerdown', pointer, true); };
  }, []);
  useEffect(() => {
    const focus = () => {
      const node = document.activeElement;
      setControlFocused(!!node?.closest('input, textarea, select, [contenteditable], iframe, dialog, .edit-popover, .crop-toolbar'));
      setFocusedEditor(focusedEditorLabel(node));
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focus);
    focus();
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus); };
  }, []);

  useEffect(() => {
    const isText = (node: Element | null) => !!node?.matches('textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="file"])');
    const focus = () => setTextEditing(isText(document.activeElement));
    const message = (event: MessageEvent) => {
      if (isRenderOrigin(event.origin) && event.data?.type === 'editor-focus' && document.activeElement instanceof HTMLIFrameElement &&
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
  const thumbScroll = useRef<HTMLDivElement>(null);
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
      if (node) {
        const animation = animateReorder(node, offset);
        if (thumbnailState.start !== undefined) animation.startTime = thumbnailState.start - performance.timeOrigin;
        thumbAnimations.current.push(animation);
      }
    }
    return () => { thumbAnimations.current.forEach(animation => animation.cancel()); };
  }, [thumbs, thumbnailState.animate, thumbnailState.start]);
  useEffect(() => {
    const cancel = () => {
      thumbAnimations.current.forEach(animation => animation.cancel());
      for (const frame of thumbList.current?.querySelectorAll<HTMLIFrameElement>('iframe') ?? []) {
        frame.contentWindow?.postMessage({ type: 'cancel-reorder' }, thumbsOrigin);
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
  const quitLock = useRef(false);
  const quitAttempt = useRef(0);
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
  const selectedPage = spread?.split ? selectedSide ?? 'left' : undefined;
  const selectedState = scopeSpread(spread, selectedPage);
  const layoutFamily = selectedState && template && pickerFamily(template.spreads, selectedState.definition, template.layoutFamilies);
  const sequence = useMemo(() => template && pageSequence(spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format), [spreads, template]);
  const selectionSide = pageSelectionSide(sequence?.spreads[index]?.page ?? {}, selectedSide ?? selectedPage);
  const pageLabels = spreads.map((_, i) => pageLabel(sequence?.spreads[i]?.page ?? {}));
  const writable = !!summary && !reload && !agentWorking;
  // A change is saved, or saved and not yet shown: on a long book with maps, rendering it again takes a second or two.
  // A reload after the book's files changed, such as a template edit, renders the whole book again and redraws its maps.
  const reloadingFiles = !!summary && (reload === 'loading' || reload === 'rendering');
  const showingChange = saving || reloadingFiles || (!!summary && !render && !!lastReady && !reload);
  const updating = useDelayed(showingChange, 250);
  // A shorter wait for the cursor, which says that something is happening without asking for attention.
  const busyCursor = useDelayed(showingChange, 100);
  // Until the book has rendered once, the spread list would show placeholder names ("Spread 1", "Blank page"), and the
  // thumbnails may arrive before or after the book view. The list appears once both show the book, in one step, or
  // a second after the book view if its thumbnails are late.
  const thumbnailsLate = useDelayed(!!lastReady && !thumbs, 1000);
  const opening = !!summary && render?.state !== 'error' && (!lastReady || (!thumbs && !thumbnailsLate));
  const updatingText = reloadingFiles ? 'Updating the book after its files changed…' : 'Updating the book…';
  const canvasReady = render?.state === 'ready' && !reload;
  const holdPreview = reload === 'loading' || typeof reload === 'object';
  const generation = inputGeneration.current;
  const spreadSelected = !selectedSource;
  // The selection as the views show it. A new spread is outlined once both the book view and the thumbnails show it;
  // until then the sheet selected before stays outlined, so the selection never disappears while they update.
  const outlinedSpread = useRef(spreadId);
  const showsSelected = (sheets?: readonly { spread: string }[]) => !!sheets?.some(({ spread }) => spread === spreadId);
  if ((showsSelected(geometry?.sheets) && showsSelected(thumbs?.sheets)) || !geometry?.sheets.some(({ spread }) => spread === outlinedSpread.current)) {
    outlinedSpread.current = spreadId;
  }
  const outlined = outlinedSpread.current;
  const awaitingSelection = outlined !== spreadId;
  const canChangeBook = writable && !busy && !exporting;
  const canReorder = canChangeBook && !!template;
  const canMoveSpread = (id: string, target: number) => !!template && !!spreadOrder(spreads, id, target, template);
  function insertionAfter(item: SpreadState, list: SpreadState[]) {
    const position = list.findIndex(entry => entry.id === item.id);
    const currentItem = list[position];
    const footprint = template && currentItem && layoutFootprint(currentItem, template.spreads);
    const closing = template && hasSingleEnds(template.format) && position === list.length - 1 && list.length > 1 &&
      (footprint?.span === 'left' || footprint?.span === 'page');
    return closing || footprint?.span === 'left' ? position : position + 1;
  }
  const addLayouts = template ? spread ? editorLayoutsAt(template.spreads, template.format,
    { index: insertionAfter(spread, spreads), count: spreads.length + 1 }) : firstEditorLayouts(template.spreads, template.format) : [];
  const canAdd = canChangeBook && addLayouts.length > 0;
  // A single opening or closing page cannot be duplicated where the format requires one of each.
  const canDuplicate = canChangeBook && !!template && spreadSelected && !!spread &&
    !selectedSpreads.some((id) => hasSingleEnds(template.format) && ['left', 'right'].includes(sequence?.spreads[spreads.findIndex((spread) => spread.id === id)]?.span ?? ''));
  const canDelete = canChangeBook && spreadSelected && !!spread;
  const canMoveUp = canReorder && spreadSelected && !!spread && (selectedSpreads.length > 1 ? !!spreadSelectionOrder(spreads, selectedSpreads, 'up', template!) : canMoveSpread(spread.id, index - 1));
  const canMoveDown = canReorder && spreadSelected && !!spread && (selectedSpreads.length > 1 ? !!spreadSelectionOrder(spreads, selectedSpreads, 'down', template!) : canMoveSpread(spread.id, index + 1));
  // This is the render-session ID, regenerated by DocumentSession.activate() on save, history and reload.
  const reorder = useSpreadReorder({ list: thumbList, revision: summary?.id, enabled: canReorder && !panels.leftHidden,
    canMove: canMoveSpread, move: moveTo });

  function clearCanvasEditors() {
    setCropping(undefined);
    setHoverEpoch(value => value + 1);
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
    const previousSpreads = current.current?.project.spreads ?? [];
    current.current = next;
    candidateId.current = next.id;
    readyId.current = undefined;
    if (reset) {
      inputGeneration.current++;
      reloading.current = false;
      reloadFailed.current = false;
      setSelectedSide(undefined);
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
      liveZoom.current = 1; setZoomState(1); fitAnchor.current = undefined; pinchAnchor.current = undefined;
      clearCanvasEditors();
      pendingReveal.current = undefined;
      viewAnchor.current = undefined; pendingAnchor.current = undefined;
      revealedThumb.current = '';
      canvas.current?.scrollTo({ top: 0, left: 0 });
    }
    // A book may have no spreads yet; then nothing is selected.
    // A selected sheet that is gone hands the selection to the sheet now in its place, not to the first one.
    const inPlaceOf = (id: string) => {
      const at = previousSpreads.findIndex((spread) => spread.id === id);
      const kept = new Set(next.project.spreads.map(({ id }) => id));
      return at < 0 ? undefined : (previousSpreads.slice(at).find(({ id }) => kept.has(id)) ?? previousSpreads.slice(0, at).findLast(({ id }) => kept.has(id)))?.id;
    };
    setSpreadId((previous) => selected ?? (reset ? next.project.spreads[0]?.id :
      next.project.spreads.find(({ id }) => id === previous)?.id ?? inPlaceOf(previous) ?? next.project.spreads[0]?.id) ?? '');
    if (selected) { pendingReveal.current = selected; if (selected !== spreadId) setSelectedSide(undefined); }
    // The selected sheet is gone (an agent removed it, say): the fallback sheet starts on its default page.
    else if (!next.project.spreads.some(({ id }) => id === spreadId)) setSelectedSide(undefined);
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
      if (!api || !before || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
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
      if (!api || !before || agentLocked.current || reloading.current || generation !== inputGeneration.current) return;
      const result = await persist(() => api.history(before.id, direction));
      if ('error' in result) throw new Error(result.error);
      if (current.current !== before) return;
      adopt(result.value);

    });
  }

  function importFiles(request: ImportRequest, canvasId?: string) {
    // Without a kind, photos and Markdown are recognised by type; the template's file parameters add the types they accept.
    if (!request.kind && !request.accept) request = { ...request, accept: fileExtensions(template) };
    const generation = inputGeneration.current;
    enqueue(async () => {
      const before = current.current;
      if (!api || !before || agentLocked.current || reloading.current || generation !== inputGeneration.current ||
          (canvasId && (before.id !== canvasId || readyId.current !== canvasId))) return;
      setBusy('Importing files…');
      const result = await persist(() => api.importFiles(before.id, request));
      if ('error' in result) throw new Error(result.error);
      if (!result.value || current.current !== before) return;
      if (result.value.imported.length) adopt(result.value.summary);
      // Imports into the library select the first new source; imports onto a box keep the spread selected.
      if (!request.target && result.value.imported.length) {
        const [first] = result.value.imported;
        // Files for parameters are not photos or texts: the tab stays where it is and nothing is selected.
        const kind = result.value.summary.photoIndex[first] ? 'photo' : result.value.summary.project.texts[first] ? 'text' : undefined;
        if (kind) { setSourceTab(kind); setSelectedSource({ kind, id: first }); }
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
        if (!api || !before || agentLocked.current || reloading.current || generation !== inputGeneration.current) return resolve(undefined);
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
    const accept = fileExtensions(template);
    const result = await api.showAssets(accept);
    if ('error' in result) setError(result.error);
  }

  function present(id: string) {
    if (!api || !summary || editing || cropping || elementEditor) return;
    void api.startPresentation(id).then((result) => { if ('error' in result) setError(result.error); })
      .catch(() => setError('Could not open presentation.'));
  }
  function act(command: Command) {
    if (isPhotoViewCommand(command)) { photoView.command(command); return; }
    if (command === 'presentation' || command === 'presentation-start') {
      present(command === 'presentation-start' ? summary?.project.spreads[0]?.id ?? '' : spreadId);
      return;
    }
    if (command === 'swap-pages') {
      if (!controlFocused && !editing && !cropping && !elementEditor && !quick && selectedSpreads.length <= 1) swapSelectedPages();
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
      const fittedScale = fittedGeometry?.sheets.find(sheet => sheet.spread === spreadId)?.zoom ?? fittedGeometry?.sheets[0]?.zoom;
      setZoom(fittedScale ? 1 / fittedScale : 1); return;
    }
    if (command === 'import') return importFiles({});
    if (command === 'copy-assets') {
      edit(({ project }) => { project.importMode = project.importMode === 'link' ? 'copy' : 'link'; }, 'Import policy changed');
      return;
    }
    enqueue(async () => {
      if (!api || agentLocked.current) return;
      const before = current.current;
      if (command === 'export') {
        if (!before || readyId.current !== before.id) return;
        setBusy('Preparing export…');
        setExporting(true);
        const result = await api.exportBook(before.id);
        if ('error' in result) throw new Error(result.error);
        if (!result.value) return;
        // The export rendered the whole book; its result is the complete Book check for that project state.
        const { errors, warnings } = result.value;
        const counted = (n: number, word: string) => n ? n + ' ' + word + (n === 1 ? '' : 's') : '';
        const found = [counted(errors.length, 'error'), counted(warnings.length, 'warning')].filter(Boolean).join(', ');
        setNotice('PDF saved.' + (found ? ' ' + found + ' in Book check.' : ''));
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
    // Operations the user cannot finish by closing an editor refuse plainly; only an open editor is named to the agent.
    const reloadRunning = reloading.current && !reloadFailed.current;
    if (pendingTasks.current || busy || reloadRunning || reorder.dragging || agentLocked.current) return { busy:
      busy ? busy.replace(/…$/, '').toLowerCase() : reloadRunning ? 'reloading the book after its files changed' : reorder.dragging ? 'a drag in the editor'
        : agentLocked.current ? 'another agent change' : 'saving an edit' };
    if (editing || elementEditor || cropping) return activeEditor ?? false;
    const typing = focusedEditorLabel(document.activeElement);
    if (typing) return { label: typing };
    agentLocked.current = true;
    if (workspace.current) workspace.current.inert = true;
    setAgentWorking(true);
    return true;
  });
  const finishQuit = useEffectEvent(() => {
    const reloadRunning = reloading.current && !reloadFailed.current;
    if (pendingTasks.current || busy || reloadRunning || editing || elementEditor || cropping || reorder.dragging || agentLocked.current ||
        document.querySelector('.field[aria-invalid="true"], .field[data-pending="true"]')) return false;
    quitLock.current = true;
    agentLocked.current = true;
    if (workspace.current) workspace.current.inert = true;
    return true;
  });
  const prepareQuit = useEffectEvent(async () => {
    const attempt = ++quitAttempt.current;
    // Inspector fields commit on blur. Focus in a saved field, select or harmless dialog isn't a draft.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('input, textarea, select, [contenteditable="true"]') && !focused.closest('dialog')) focused.blur();
    await queue.current;
    // A book reload (for example after a text was saved) writes nothing and settles on its own, so Quit waits for it
    // rather than refusing. A reload that is still running after the wait refuses as before.
    const deadline = Date.now() + 15_000;
    while (reloading.current && !reloadFailed.current && attempt === quitAttempt.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 0)); // React publishes validation and save results.
    return attempt === quitAttempt.current && finishQuit();
  });
  function placeSources(keys: string[], target = spreadId, firstBox?: string, page: PageSide | undefined = target === spreadId ? selectedPage : undefined) {
    if (!template || !writable || !summary) return;
    const state = scopeSpread(spreads.find(({ id }) => id === target), page);
    const definition = state && template.spreads[state.definition];
    if (!definition) return;
    const sources = keys.flatMap<SourceRef>((key) => {
      const [kind, id] = key.split(':');
      return kind === 'photo' && summary.photoIndex[id] ? [{ kind: 'photo' as const, id }] : kind === 'markdown' && summary.project.texts[id] ? [{ kind: 'text' as const, id }] : [];
    });
    const assignments = sourcePlacements(definition.boxes, state.boxes, sources, firstBox);
    if (!assignments.length) { setNotice('This spread has no empty matching boxes.'); return; }
    select(target, false, page);
    edit(({ project }) => {
      const spread = editableSpread(project.spreads.find(({ id }) => id === target), page);
      if (spread?.definition !== state.definition) return false;
      for (const { box, source } of assignments) spread.boxes[box] = { params: spread.boxes[box]?.params ?? {}, ...(source.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
    }, 'Placed ' + assignments.length + ' of ' + sources.length + ' assets');
  }
  const onSourceCommand = useEffectEvent((request: import('./desktop').SourceCommand) => {
    if (request.action === 'jump') select(request.spread);
    else placeSources(request.keys);
  });
  const onPresentationClosed = useEffectEvent((id: string) => {
    if (current.current?.project.spreads.some((spread) => spread.id === id)) select(id);
    canvas.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!api) return;
    const prepare = api.onPrepareQuit(() => prepareQuit());
    const cancelQuit = api.onCancelQuit(() => {
      quitAttempt.current++;
      if (!quitLock.current) return;
      quitLock.current = false;
      agentLocked.current = false;
      if (workspace.current) workspace.current.inert = false;
    });
    const sourceCommand = api.onSourceCommand(onSourceCommand);
    const presentationClosed = api.onPresentationClosed(onPresentationClosed);
    const lease = api.onAgentLease(() => acquireAgentLease());
    const release = api.onAgentRelease(() => {
      agentLocked.current = quitLock.current;
      if (workspace.current) workspace.current.inert = quitLock.current;
      setAgentWorking(false);
    });
    const command = api.onCommand((command) => onCommand(command));
    const changed = api.onProjectChanged((change) => onProjectChanged(change));
    // Progress belongs to the import or export that is running. A message can arrive after its task has finished and
    // cleared the status (IPC sends are not ordered with invoke replies); taking it then would leave the book busy,
    // with a spinner that never stops and Quit refused.
    const progress = api.onProgress((stage) => { if (pendingTasks.current) setBusy(stage); });
    const appError = api.onAppError(setError);
    const appNotice = api.onAppNotice(setNotice);
    let mounted = true;
    void api.currentProject().then((result) => {
      if (!mounted || current.current) return;
      if ('error' in result) setError(result.error);
      else adopt(result.value, true);
    });
    return () => { mounted = false; prepare(); cancelQuit(); sourceCommand(); presentationClosed(); command(); changed(); progress(); lease(); release(); appError(); appNotice(); };
  }, [api]);

  // Network origins the template declares (ADR 0006): checked once per book and template version (its hash) when it
  // first renders, and again whenever an element editor opens. The user's own books never ask; a book from elsewhere
  // asks once whether to trust it. Newly allowed origins reload the frames so they may reach them.
  const networkAsked = useRef(new Set<string>());
  // Resolves to the project ID to render from now on.
  function decideNetwork(declared: TemplateInfo | undefined, always = false): Promise<string | void> {
    const before = current.current;
    if (!api || !before || !declared?.network?.length) return Promise.resolve(before?.id);
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
  function reveal(id: string, instant = false) {
    const sheet = geometry?.sheets.find(({ spread }) => spread === id);
    const view = canvas.current;
    if (!sheet || !view || !stage.current) {
      pendingReveal.current = id;
      return;
    }
    pendingReveal.current = undefined;
    const label = bookLayout.book.gap;
    // A spread that has just appeared, such as a new one, is shown at once with the update rather than scrolled to after it.
    const behavior = instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    const top = stage.current.offsetTop + sheet.y;
    if (top - label >= view.scrollTop && top + sheet.height <= view.scrollTop + view.clientHeight) return;
    view.scrollTo({ top: Math.max(0, top - Math.max(label, (view.clientHeight - sheet.height) / 2)), behavior });
  }
  // The visible area in canvas coordinates, which follow the editor zoom.
  function viewport() {
    const view = canvas.current;
    if (!view || !stage.current) return undefined;
    const top = view.scrollTop - stage.current.offsetTop;
    const left = view.scrollLeft - stage.current.offsetLeft;
    return { top, bottom: top + view.clientHeight, left, right: left + view.clientWidth, columns };
  }
  function frameViewport() {
    const range = viewport();
    if (!range) return undefined;
    // Artwork stays laid out at Fit. The frame loads pictures for the visible area in its own coordinates.
    return { top: range.top / zoom, bottom: range.bottom / zoom, left: range.left / zoom, right: range.right / zoom, columns };
  }
  // Tells a view's current and pending frames which area is on screen, so they load the pictures near it.
  function postViewport(host: HTMLElement | null, view: 'book' | 'thumbs', range: ReturnType<typeof viewport>) {
    if (!host || !range) return;
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('iframe.book-frame-' + view)) {
      frame.contentWindow?.postMessage({ type: 'viewport', ...range }, view === 'thumbs' ? thumbsOrigin : renderOrigin);
    }
  }
  function measureView() { postViewport(stage.current, 'book', frameViewport()); }
  function thumbnailViewport() {
    const view = thumbScroll.current;
    if (!view) return undefined;
    // The placed thumbnail list has no padding, so the scroll position is already in the frame's coordinates.
    const top = view.scrollTop;
    return { top, bottom: top + view.clientHeight, left: 0, right: view.clientWidth, columns: 0 };
  }
  function measureThumbnails() { postViewport(thumbList.current, 'thumbs', thumbnailViewport()); }
  useEffect(() => {
    const view = thumbScroll.current;
    if (!view) return;
    const observer = new ResizeObserver(measureThumbnails);
    observer.observe(view);
    return () => observer.disconnect();
  }, [projectInstance]);
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
  // Book settings take the height the user gives them above the spread list, up to what leaves the list usable.
  const bookSettings = useSectionOpen('project.settings', false);
  const projectContent = useRef<HTMLDivElement>(null);
  const [settingsMaximum, setSettingsMaximum] = useState(Infinity);
  useLayoutEffect(() => {
    const content = projectContent.current;
    if (!content || !bookSettings[0]) return;
    const measure = () => {
      const body = content.querySelector<HTMLElement>('.document-settings > .panel-section-body');
      const bar = content.querySelector<HTMLElement>('.spread-bar');
      if (!body) return;
      // The list keeps at least 120px; the divider is 6px.
      setSettingsMaximum(Math.max(48, Math.floor(content.getBoundingClientRect().bottom - body.getBoundingClientRect().top - (bar?.offsetHeight ?? 0) - 6 - 120)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [bookSettings[0], !!summary, !!template]);
  const settingsHeight = Math.min(panels.settings, settingsMaximum);
  const resizeSettings: typeof resizePanelState = (side, size) => resizePanelState(side, Math.min(size, settingsMaximum));
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
      reveal(pendingReveal.current, true);
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
      if (String(canvas.current?.clientWidth) === anchorSize.current?.split('x')[0]) {
        setGeometry((current) => current && { ...current });
      }
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
    // A newly inserted button exists before its preview supplies a position; revealing it then scrolls to the top.
    if (!spreadId || revealedThumb.current === spreadId || !thumbs?.sheets.some(sheet => sheet.spread === spreadId)) return;
    const button = thumbList.current?.querySelector<HTMLElement>('[data-spread="' + CSS.escape(spreadId) + '"]');
    const list = thumbList.current?.parentElement;
    if (!button || !list) return;
    revealIn(list, button);
    revealedThumb.current = spreadId;
  }, [spreadId, thumbs]);

  // Without a side, reselecting the current sheet keeps its selected page (a click on its label, say); another
  // sheet starts on its default page.
  function select(id: string, scroll = true, side?: PageSide) {
    pendingAnchor.current = undefined;
    setSpreadId(id);
    setSelectedSide(side ?? (id === spreadId ? selectedSide : undefined));
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
      const pages = pageSequence(ordered.map((spread) => layoutFootprint(spread, template.spreads)), template.format).spreads[target].page;
      destination = pagesText(pages).toLowerCase();
    }, () => 'Spread moved to ' + destination, id);
  }

  // Starts an empty book: with one layout, or with the template's opening spreads.
  function start(layout?: string) {
    if (!template || spreads.length) return;
    const initial = layout && newEditorSpread(layout, template.spreads, template.format, { index: 0, count: 2 });
    const added = layout ? initial ? [initial] : [] : openingSpreadStates(template);
    if (!added.length) return;
    edit(({ project }) => {
      if (project.spreads.length) return false;
      project.spreads = added;
    }, layout ? 'Added ' + (template.spreads[layout]?.label ?? layout) : "Added the template's opening spreads", added[0].id);
  }

  function add(duplicate = false, spread = spreads[index]) {
    if (!template) return;
    if (!spread) {
      if (!duplicate) start(firstEditorLayouts(template.spreads, template.format)[0]);
      return;
    }
    const position = { index: insertionAfter(spread, spreads), count: spreads.length + 1 };
    const eligible = editorLayoutsAt(template.spreads, template.format, position);
    const definition = eligible.find(id => template.spreads[id].span === 'spread') ?? eligible[0];
    // A new spread continues the selected one's layout where it fits, and otherwise takes the first layout that does.
    const next = duplicate ? { ...structuredClone(spread), id: crypto.randomUUID() }
      : continuedSpread(spread, template.spreads, template.format, position) ?? (definition && newEditorSpread(definition, template.spreads, template.format, position));
    if (!next) return;
    edit(({ project }) => {
      if (!project.spreads.some(item => item.id === spread.id)) return false;
      const insert = insertionAfter(spread, project.spreads);
      if (insertionProblem(project.spreads, insert, layoutFootprint(next, template.spreads).span, template, layoutFootprint(next, template.spreads).sides)) return false;
      project.spreads.splice(insert, 0, next);
    }, undefined, next.id);
  }

  function deleteSelected(ids: string[]) {
    if (!canChangeBook || !ids.length) return;
    // The sheet after the deleted ones then takes the selection (adopt), so the thumbnails stay where the user was.
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
  async function spreadMenu(id: string, ids = spreadSelection.selected.includes(id) ? spreadSelection.selected : [id], side?: PageSide) {
    const selected = spreads.find((spread) => spread.id === id);
    if (!selected || !api || !template) return;
    select(id, false, side);
    const at = spreads.indexOf(selected);
    const state: BookMenuState = { ...menuState, editing: false, enabled: {
      'add-spread': canAdd, 'delete-spread': canChangeBook,
      'duplicate-spread': canChangeBook && !ids.some((id) => hasSingleEnds(template.format) && ['left', 'right'].includes(sequence?.spreads[spreads.findIndex((spread) => spread.id === id)]?.span ?? '')),
      'move-spread-up': canReorder && !!spreadSelectionOrder(spreads, ids, 'up', template), 'move-spread-down': canReorder && !!spreadSelectionOrder(spreads, ids, 'down', template),
    } };
    const choices = editorLayoutPreviews(template.spreads, selected, template.layoutFamilies ?? {}, template.format, { index: at, count: spreads.length }, side);
    const result = await api.showContextMenu(['add-spread', { command: 'duplicate-spread', label: ids.length > 1 ? 'Duplicate ' + ids.length + ' Spreads' : undefined }, 'move-spread-up', 'move-spread-down',
      'move-spread-start', 'move-spread-end', ...(choices.length > 1 && ids.length === 1 ? [{ command: 'change-layout' as const, items: choices.map((value) => ({ command: 'change-layout' as const, value, label: template.spreads[value].label, checked: value === (selected.split ? selected.pages?.[side ?? 'left']?.definition : selected.definition) })) }] : []),
      { type: 'separator' }, ...(spreadIssues.has(id) ? [{ command: 'book-check' as const, label: 'Check This Spread' }] : []), { command: 'delete-spread', label: ids.length > 1 ? 'Delete ' + ids.length + ' Spreads' : undefined }], state);
    if (current.current?.id !== summary?.id) return;
    const command = result?.command;
    if (command === 'change-layout' && result?.value && choices.includes(result.value)) applyEditorLayout(id, result.value, side);
    else if (command === 'add-spread') add(false, selected);
    else if (command === 'duplicate-spread') { if (ids.length > 1) duplicateSelected(ids); else add(true, selected); }
    else if (command === 'delete-spread') deleteSelected(ids);
    else if (command === 'move-spread-up') moveSelected(ids, 'up');
    else if (command === 'move-spread-down') moveSelected(ids, 'down');
    else if (command === 'move-spread-start') moveSelected(ids, 'start');
    else if (command === 'move-spread-end') moveSelected(ids, 'end');
    else if (command === 'book-check') { setCheckScope(id); setCheckRequest((value) => value + 1); }
  }
  async function canvasMenu(event: Pick<React.MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>) {
    event.preventDefault();
    const { sheet, side, top } = locate(event);
    if (!sheet || !summary || !template || !api) return;
    if (!top || top.type === 'element') { await spreadMenu(sheet, [sheet], side); return; }
    select(sheet, false, side);
    const source = boxSource(sheet, top.id, top.page);
    const photo = top.type === 'photo';
    const items: import('./desktop').ContextMenuItem[] = photo ? ['box-replace-photo',
      { command: 'box-adjust-crop', enabled: !!source && !cropBlocked(sheet, top.id, top.page) }, { command: 'box-reset-crop', enabled: !!source }] : ['box-edit-text', 'box-replace-text'];
    if (source) items.push({ type: 'separator' }, 'asset-preview', 'box-show-assets', photo ? 'box-remove-photo' : 'box-remove-text');
    const result = await api.showContextMenu(items, { ...menuState, editing: false });
    if (!result || current.current?.id !== summary.id) return;
    switch (result.command) {
      case 'box-replace-photo': case 'box-replace-text': importFiles({ kind: photo ? 'photo' : 'markdown', target: { spread: sheet, box: top.id, page: top.page } }); break;
      case 'box-adjust-crop': startCrop(sheet, top.id, top.page); break;
      case 'box-reset-crop': changeSpreadAt(sheet, (spread) => { const box = spread.boxes[top.id]; if (box?.photo) setPlacement(box, spread.definition, centered); }, 'Crop reset', top.page); break;
      case 'box-edit-text': openOwner(sheet, { type: 'markdown', id: top.id, page: top.page }); break;
      case 'asset-preview': if (source) setQuick(source); break;
      case 'box-show-assets': if (source) { choose(source); showPanel('bottom'); } break;
      case 'box-remove-photo': case 'box-remove-text': changeSpreadAt(sheet, (spread) => { spread.boxes[top.id] = { params: spread.boxes[top.id]?.params ?? {} }; }, photo ? 'Photo removed' : 'Text removed', top.page); setCropping(undefined); break;
    }
  }
  function changeFormat(format: string) {
    if (!canChangeBook || !template || !Object.hasOwn(template.formats, format)) return;
    edit(({ project }) => { project.format = format; }, 'Format changed to ' + template.formats[format]);
  }

  function assign(spread: string, box: string, source: SourceRef, page?: PageSide) {
    editCanvas(({ project }) => {
      const state = editableSpread(project.spreads.find(({ id }) => id === spread), page);
      if (state) state.boxes[box] = { params: state.boxes[box]?.params ?? {}, ...(source.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
    });
  }

  // Place kept or replaced content into an explicitly addressed shown box.
  function place(id: string, from: KeptItem, to: ContentTarget, fromCanvas = false) {
    if (!summary || !template) return;
    const sourceSummary = summary;
    const sheet = spreads.find(item => item.id === id);
    const label = sheet && shownContentTargets(sheet, template.spreads, from.kind).find(item => item.box === to.box && item.page === to.page)?.label;
    let swapped: string | undefined;
    const apply = fromCanvas ? editCanvas : edit;
    apply(({ project }) => {
      const sheet = project.spreads.find(item => item.id === id);
      if (!sheet || !keptItems(sheet, template.spreads).some(item => item.id === from.id && item.kind === from.kind && item.source === from.source &&
            item.location === from.location && item.displaced === from.displaced) ||
          !shownContentTargets(sheet, template.spreads, from.kind).some(item => item.box === to.box && item.page === to.page)) return false;
      swapped = placeKeptContent(sheet, from, to);
    }, () => sourceTitle(sourceSummary, from.kind, from.source) + ' placed in ' + (label ?? to.box) +
      (swapped ? '; ' + sourceTitle(sourceSummary, from.kind, swapped) + ' is set aside' : ''));
    select(id, false, to.page);
    setFocusBox({ box: to.box, at: Date.now() });
  }

  function applyEditorLayout(id: string, definition?: string, side?: PageSide) {
    if (!template || !writable) return;
    const layouts = template.spreads;
    let consequence = '';
    edit(({ project }) => {
      const at = project.spreads.findIndex(item => item.id === id);
      const sheet = project.spreads[at];
      if (!sheet) return false;
      const position = { index: at, count: project.spreads.length };
      const target = editorLayoutTarget(layouts, definition, template.format, position, side);
      if (definition === undefined ? !target.page : !editorLayoutChoices(layouts, sheet, template.format, position, side).includes(definition)) return false;
      consequence = describeLayoutChange(switchLayout(sheet, target, layouts));
    }, () => (definition ? layouts[definition].label : 'Blank page') + (consequence ? ' · ' + consequence : ''));
    clearCanvasEditors();
    setEditing(undefined);
    setElementEditor(undefined);
    const target = editorLayoutTarget(layouts, definition, template.format, { index: spreads.findIndex(item => item.id === id), count: spreads.length }, side);
    select(id, false, target.page ?? side);
  }

  const chooseInspectorLayout = useLiveCallback((definition?: string) => {
    if (spread) applyEditorLayout(spread.id, definition, selectedSide ?? selectedPage);
  });
  const swapSelectedPages = useLiveCallback(() => {
    if (!spread || !template || !writable || !hasFacingPages(template.format) || sequence?.spreads[index]?.span !== 'spread') return;
    edit(({ project }) => {
      const sheet = project.spreads.find(item => item.id === spread.id);
      if (!sheet || !canSwapPages(sheet, template.spreads)) return false;
      swapPages(sheet);
    }, 'Pages swapped');
    clearCanvasEditors();
    setEditing(undefined);
    setElementEditor(undefined);
  });

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
    const sheetRect = geometry.sheets.find((rect) => inside(rect, bookLayout.book.gap));
    const sheet = sheetRect?.spread;
    const at = spreads.findIndex(item => item.id === sheet);
    const side = sheetRect && pageSideAt(sheetRect, sequence?.spreads[at]?.page ?? {}, x, y);
    if (readyId.current !== summary?.id) return { sheet, side };
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
    return { sheet, side, box, element, top, target: target && (!box || area(target) <= area(box)) ? target : undefined };
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
    const own = geometry?.targets.find((target) => target.spread === spread && target.page === owner.page && target.owner?.type === type && target.owner.id === owner.id);
    if (own) return own;
    const rect = geometry?.boxes.find((box) => box.spread === spread && box.page === owner.page && box.id === owner.id && (box.type === 'element') === (type === 'element'));
    if (rect) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, spread, page: owner.page, edits: [], occurrence: 0, owner: { type, id: owner.id } };
    const sheet = geometry?.sheets.find((item) => item.spread === spread);
    const layout = template?.spreads[scopeSpread(spreads.find(({ id }) => id === spread), owner.page)?.definition ?? ''];
    const declared = type === 'element' ? layout?.elements[owner.id] : layout?.boxes[owner.id];
    if (!sheet || !declared) return undefined;
    return { x: sheet.x + 12, y: sheet.y + 12, width: 0, height: 0, spread, page: owner.page, occurrence: 0, owner: { type, id: owner.id }, hidden: true,
      edits: Object.keys(declared.parameters).map((key) => (type === 'element' ? 'elements.' : 'boxes.') + owner.id + '.' + key) };
  }
  // Parameters a template marked on a box besides its own, such as a spread setting shown in its caption.
  const attachedEdits = (target: Target | undefined, owner: Owner) =>
    target?.edits.filter((path) => !path.startsWith((owner.type === 'element' ? 'elements.' : 'boxes.') + owner.id + '.')) ?? [];
  const ownerKey = (spread: string, id: string, page?: PageSide) => spread + (page ? '@' + page : '') + '|#' + id;
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
  // Text the template edits on the page, opened in the panel only because it is too small on screen at this zoom
  // (inline-text: textFits). The panel says so, and offers the zoom at which it can be edited where it is.
  const smallText = editing && !editing.owner && !editing.panel && !textInline && inline?.target.inlineText &&
    inline.target.upright !== false && !textFits(inline.target) ? inline.target : undefined;
  const textZoom = smallText && (() => {
    const { along, across } = textExtent(smallText);
    const needed = zoom * Math.max(minimumText.along / Math.max(along, 1), minimumText.across / Math.max(across, 1)) * 1.1;
    return needed <= 3 ? Math.max(needed, zoom * 1.2) : undefined;
  })();
  // After zooming for it, the text opens on the page once the book shows it at the new size.
  const reopenText = useRef<{ spread: string; key: string; page?: PageSide }>(undefined);
  useEffect(() => {
    const wanted = reopenText.current;
    const target = wanted && geometry?.targets.find((item) => targetKey(item) === wanted.key);
    if (!wanted || !target || !textFits(target)) return;
    reopenText.current = undefined;
    openEditing({ spread: wanted.spread, key: wanted.key, page: wanted.page });
  }, [geometry]);
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
  function changeSpreadAt(id: string, update: (spread: SpreadState) => void, notice?: string, page?: PageSide) {
    edit(({ project }) => {
      const state = editableSpread(project.spreads.find((item) => item.id === id), page);
      if (state) update(state);
    }, notice);
  }
  // The same for the spread an inline editor is open on, and only while it shows the layout it opened in.
  function changeSpreadInline(update: (spread: SpreadState) => void, notice?: string) {
    editInline(({ project }) => {
      const state = editableSpread(project.spreads.find((item) => item.id === liveInline?.spread.id), liveInline?.target.page);
      if (state) update(state);
    }, notice);
  }
  function ownerLabel(spread: SpreadState, owner: Owner) {
    const layout = template?.spreads[scopeSpread(spread, owner.page)?.definition ?? ''];
    return (owner.type === 'element' ? layout?.elements[owner.id]?.label : layout?.boxes[owner.id]?.label) ?? owner.id;
  }

  function editInline(change: Edit, notice?: string) {
    if (!liveInline || (editing?.held && !resumeInline)) return;
    edit((files) => {
      const active = files.project.spreads.find(({ id }) => id === liveInline.spread.id);
      if (editableSpread(active, liveInline.target.page)?.definition === scopeSpread(liveInline.spread, liveInline.target.page)?.definition) change(files);
    }, notice);
  }
  const editOwner = editTarget && /^boxes\.([^.]+)\./.exec(editTarget.edits[0])?.[1];
  const editElement = editTarget?.edits.map((path) => /^elements\.([^.]+)\./.exec(path)?.[1]).find(Boolean);
  const editPhotoBox = editOwner && geometry?.boxes.some(({ spread, id, type, page }) => spread === editing?.spread && page === editTarget?.page && id === editOwner && type === 'photo')
    ? editOwner : undefined;

  // Crop mode: the frame comes from the rendered book, the photo size and crop from the project.
  const cropFrame = cropping && geometry?.boxes.find(({ spread, id, page }) => spread === cropping.spread && page === cropping.page && id === cropping.box);
  const cropSheet = cropping && geometry?.sheets.find(({ spread }) => spread === cropping.spread);
  const cropState = cropping && scopeSpread(spreads.find(({ id }) => id === cropping.spread), cropping.page)?.boxes[cropping.box];
  const cropPhoto = cropState?.photo;
  const cropPlacement = cropping && placementIn(cropState, cropping.layout);
  const cropBox = cropping && template?.spreads[cropping.layout]?.boxes[cropping.box];
  const cropAttached = cropping && template ? attachedEdits(ownerTarget(cropping.spread, { type: 'photo', id: cropping.box, page: cropping.page }), { type: 'photo', id: cropping.box, page: cropping.page }) : [];
  function cropBlocked(spread: string, box: string, page?: PageSide) {
    if (readyId.current !== summary?.id) return 'The book preview is updating.';
    const state = scopeSpread(spreads.find(({ id }) => id === spread), page)?.boxes[box];
    const frame = geometry?.boxes.find((rect) => rect.spread === spread && rect.page === page && rect.id === box);
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
      const blocked = cropBlocked(spread, owner.id, owner.page);
      if (!blocked) {
        startCrop(spread, owner.id, owner.page);
        return;
      }
      // A placed photo that cannot be selected says why; its popover offers the crop as numbers.
      if (boxSource(spread, owner.id, owner.page)) setNotice(blocked);
    }
    if (owner.type === 'element' && openElementEditor(spread, owner.id, owner.page)) return;
    deselectPhoto();
    select(spread, false, owner.page);
    openEditing({ spread, key: ownerKey(spread, owner.id, owner.page), owner });
  }
  // Opens the popover of a node the template marked, such as a ctx.Text heading, from the sidebar's list.
  function openTarget(target: Target, panel = false) {
    if (target.inlineText && openTextOwner(target)) return;
    if (openDocumentEditor(target)) return;
    deselectPhoto();
    select(target.spread, false, target.page);
    openEditing({ spread: target.spread, key: targetKey(target), panel });
  }
  function openTextOwner(target: Target) {
    const state = scopeSpread(spreads.find(({ id }) => id === target.spread), target.page);
    const owner = template && state && target.edits.length === 1 && textEditorOwner(template, state.definition, target.edits[0]);
    if (!owner) return false;
    const opened = owner.kind === 'element' ? openElementEditor(target.spread, owner.element, target.page) : openDocumentEditor(target);
    if (!opened) setNotice('The book preview is updating; try again in a moment.');
    return true;
  }
  function editorOf(spread: string, element: string, page?: PageSide) {
    const state = scopeSpread(spreads.find(({ id }) => id === spread), page);
    return state && template?.spreads[state.definition]?.elements[element]?.editor;
  }
  function openElementEditor(spread: string, element: string, page?: PageSide) {
    if (readyId.current !== summary?.id || !editorOf(spread, element, page)) return false;
    setEditing(undefined);
    deselectPhoto();
    select(spread, false, page);
    // Inline when the editor asks for it and the element is on the page, upright and large enough; else the panel.
    setElementEditor({ kind: 'element', spread, element, page,
      presentation: presentationFor(editorOf(spread, element, page)!.presentation, elementRect(geometry, spread, element, page)) });
    return true;
  }
  // A node marked only with document parameters a document editor owns opens that editor, with this spread's context.
  function openDocumentEditor(target: Target, click?: OpenEditor['click']) {
    const editor = template && documentEditorFor(template, target.edits);
    const layout = scopeSpread(spreads.find(({ id }) => id === target.spread), target.page)?.definition;
    if (!editor || !layout || readyId.current !== summary?.id) return false;
    setEditing(undefined);
    deselectPhoto();
    select(target.spread, false, target.page);
    const presentation = target.hidden ? 'dialog' : presentationFor(template.editors?.[editor]?.presentation, target);
    setElementEditor({ kind: 'document', spread: target.spread, page: target.page, layout, editor, presentation,
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
    : textInline && textShown && inline ? { spread: inline.target.spread, page: inline.target.page, edits: inline.target.edits.join(' '), occurrence: inline.target.occurrence } : undefined;
  const leaveEditor = () => {
    setElementEditor((current) => current === leavingEditor ? undefined : current);
    setLeavingEditor(undefined);
  };
  useEffect(() => {
    if (!leavingEditor) return;
    const timeout = setTimeout(leaveEditor, 800);
    return () => clearTimeout(timeout);
  }, [leavingEditor]);
  function startCrop(spread: string, box: string, page?: PageSide) {
    const blocked = cropBlocked(spread, box, page);
    if (blocked) {
      setNotice(blocked);
      return false;
    }
    const layout = scopeSpread(spreads.find(({ id }) => id === spread), page)?.definition;
    if (!layout) return false;
    setEditing(undefined);
    select(spread, false, page);
    setCropping({ spread, box, layout, page });
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
    const { spread, box, layout, page } = cropping;
    edit(({ project }) => {
      const state = editableSpread(project.spreads.find(({ id }) => id === spread), page);
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
  const pendingMove = useRef<{ page?: PageSide; spread: string; box: string; photo: string; x: number; y: number }>(undefined);
  const moved = useRef(false);
  const [moving, setMoving] = useState<{ photo: string; x: number; y: number }>();
  const moveDrag = useEffectEvent((event: PointerEvent) => {
    const start = pendingMove.current;
    if (!start || readyId.current !== summary?.id) return;
    if (!moving && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
    setMoving({ photo: start.photo, x: event.clientX, y: event.clientY });
    const { box } = locate(event, [photoMime]);
    setDropTarget(box && !(box.spread === start.spread && box.page === start.page && box.id === start.box) ? box.spread + ':' + (box.page ? box.page + ':' : '') + box.id : undefined);
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
    if (!box || box.type !== 'photo' || !summary || (box.spread === start.spread && box.page === start.page && box.id === start.box)) return;
    const target = { spread: box.spread, box: box.id, page: box.page };
    const label = template?.spreads[scopeSpread(spreads.find(({ id }) => id === target.spread), target.page)?.definition ?? '']?.boxes[target.box]?.label ?? target.box;
    let swapped: string | undefined;
    editCanvas(({ project }) => {
      const from = editableSpread(project.spreads.find(({ id }) => id === start.spread), start.page);
      const to = editableSpread(project.spreads.find(({ id }) => id === target.spread), target.page);
      if (from?.boxes[start.box]?.photo === start.photo && to) swapped = swapContent(from, start.box, to, target.box);
    }, () => sourceTitle(summary, 'photo', start.photo) + (swapped ? ' and ' + sourceTitle(summary, 'photo', swapped) + ' swapped' :
      ' moved to ' + label));
    select(target.spread, false, target.page);
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
    const key = (id: string, page?: PageSide) => id + (page ? '@' + page : '');
    const next = new Map(spreads.flatMap(sheet => shownLayoutStates(sheet).map(({ page, state }) => [key(sheet.id, page), state.definition] as const)));
    const previous = layouts.current;
    const changed = (id: string, page?: PageSide) => previous.has(key(id, page)) && previous.get(key(id, page)) !== next.get(key(id, page));
    setCropping(crop => crop && changed(crop.spread, crop.page) ? undefined : crop);
    setEditing(open => open && !open.held && changed(open.spread, open.page) ? undefined : open);
    layouts.current = next;
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
    if (event.dataTransfer.types.includes(layoutMime)) {
      const { sheet, side } = locate(event);
      const definition = event.dataTransfer.getData(layoutMime);
      if (sheet && template && (definition === '__blank__' || Object.hasOwn(template.spreads, definition))) applyEditorLayout(sheet, definition === '__blank__' ? undefined : definition, side);
      return;
    }
    if (event.dataTransfer.types.includes(photosMime)) {
      const { sheet, box } = locate(event, event.dataTransfer.types);
      try {
        const ids: unknown = JSON.parse(event.dataTransfer.getData(photosMime));
        if (sheet && Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === 'string')) placeSources(ids.map((id) => 'photo:' + id), sheet, box?.id, box?.page);
      } catch { setNotice('Could not read the selected photos.'); }
      return;
    }

    const { box } = locate(event);
    // Kept content dropped on its own spread moves; dropped on another spread it is another use of its source.
    const kept = event.dataTransfer.getData(keptMime);
    if (kept && box && box.type !== 'element') {
      const origin = JSON.parse(kept) as KeptItem & { spread: string };
      if (origin.spread === box.spread) {
        const { spread: _spread, box: _box, ...item } = origin as typeof origin & { box?: string };
        place(origin.spread, item, { box: box.id, page: box.page }, true);
        return;
      }
    }
    const photoId = event.dataTransfer.getData(photoMime);
    const textId = event.dataTransfer.getData(textMime);
    if (photoId || textId) {
      if (photoId && box?.type === 'photo' && summary.photoIndex[photoId]) assign(box.spread, box.id, { kind: 'photo', id: photoId }, box.page);
      if (textId && box?.type === 'markdown' && summary.project.texts[textId]) assign(box.spread, box.id, { kind: 'text', id: textId }, box.page);
      if (box) select(box.spread, false, box.page);
      return;
    }
    const paths = api.pathsForFiles([...event.dataTransfer.files]);
    if (!paths.length) return;
    const kind = box?.type === 'markdown' ? 'markdown' : box?.type === 'photo' ? 'photo' : undefined;
    if (box) select(box.spread, false, box.page);
    importFiles({ kind, paths, target: box && box.type !== 'element' ? { spread: box.spread, box: box.id, page: box.page } : undefined }, summary.id);
  }

  // Clicking a box shows its source in the source inspector; double-clicking opens Quick Look.
  function boxSource(spread: string, box: string, page?: PageSide): SourceRef | undefined {
    const state = scopeSpread(spreads.find(({ id }) => id === spread), page)?.boxes[box];
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
    if (event.defaultPrevented || !event.shiftKey || event.code !== 'KeyW' || event.metaKey || event.ctrlKey ||
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

  const canvasGestures = useCanvasGestures({ canvas, instance: projectInstance,
    active: canvasReady && !editing && !cropping && !elementEditor && !quick,
    zoom, zoomAt: (factor, point) => setZoom((value) => value * factor, point),
    fit: () => setZoom(1), scrolling: () => { pendingAnchor.current = undefined; pinchAnchor.current = undefined; } });

  // Left/right follow pages; up/down follow sheets or rows in the grid.
  function canvasArrowKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || !spreadSelected || !spread) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, button, [contenteditable], dialog')) return;
    if (editing || cropping || elementEditor || quick) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = stepPageSelection(spreads.map((item, i) => ({ id: item.id, page: sequence?.spreads[i]?.page ?? {} })),
        { spread: spread.id, side: selectedSide }, event.key === 'ArrowLeft' ? -1 : 1);
      if (next) { event.preventDefault(); select(next.spread, true, next.side); }
      return;
    }
    const step = columns
      ? { ArrowUp: -columns, ArrowDown: columns }[event.key]
      : { ArrowUp: -1, ArrowDown: 1 }[event.key];
    const next = step && spreads[index + step];
    if (!next) return;
    event.preventDefault();
    select(next.id);
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
  const activeBox = dropTarget ? geometry?.boxes.find(({ spread, id, page }) => spread + ':' + (page ? page + ':' : '') + id === dropTarget) :
    highlight ? geometry?.boxes.find(({ spread: owner, id, page }) => owner === spread?.id && id === highlight && page === selectedPage) : undefined;
  const selectedSheetRect = spreadSelected ? geometry?.sheets.find(({ spread: id }) => id === spread?.id) : undefined;
  const selectionPages = sequence?.spreads[index]?.page;
  const selectedLayoutMode = spread?.split ? 'pages' : selectionPages?.left !== undefined && selectionPages?.right !== undefined ? 'spread' : 'page';
  const selectedSheet = selectedSheetRect && pageSelectionRect(selectedSheetRect, selectedLayoutMode === 'spread' ? undefined : selectionSide);
  const activeSpreadPage = selectedSheetRect && selectedLayoutMode === 'spread' && selectionSide
    ? pageSelectionRect(selectedSheetRect, selectionSide) : undefined;
  const facingSheet = selectedSheetRect && selectedLayoutMode === 'pages' && selectionSide
    ? pageSelectionRect(selectedSheetRect, selectionSide === 'left' ? 'right' : 'left') : undefined;
  const previewError = typeof reload === 'object' ? reload.error : render?.state === 'error' ? render.message : '';
  const issue = previewError || error;
  const previewNotice = agentWorking ? 'Agent is updating the book…' : previewError ? (geometry ? 'Showing the last successful preview' : 'Book preview unavailable') : '';
  const blockedInline = editing?.held && !resumeInline && (canvasReady
    ? 'This field changed while you were editing. Close it and open the field again to continue.'
    : 'Editing is paused while the preview is out of date.');
  const canExport = canvasReady && !busy && spreads.length > 0;
  let activeEditor: ActiveBookEditor | undefined;
  if (editing) {
    const field = editTarget?.edits.join(', ') || editing.held?.target.edits.join(', ') || editing.owner?.id;
    activeEditor = { label: editing.text ? 'text editor' : 'parameter editor', spread: editing.spread, page: editing.page, field };
  } else if (elementEditor) {
    activeEditor = { label: elementEditor.kind === 'element' ? 'element editor' : 'document editor',
      spread: elementEditor.spread, page: elementEditor.page, field: elementEditor.kind === 'element' ? elementEditor.element : elementEditor.editor };
  } else if (cropping) {
    activeEditor = { label: 'crop editor', spread: cropping.spread, page: cropping.page, field: cropping.box };
  } else if (focusedEditor) activeEditor = { label: focusedEditor };
  const menuState: BookMenuState = { importMode: summary?.project.importMode, document: !!summary, enabled: { 'add-spread': canAdd, 'duplicate-spread': canDuplicate,
    'move-spread-up': canMoveUp, 'move-spread-down': canMoveDown, 'delete-spread': canDelete && spreadFocused },
    editing: controlFocused || !!editing || !!cropping || !!elementEditor || !!quick, textEditing,
    writable, busy: !!busy || exporting || !!reload || agentWorking, history: summary?.history,
    canExport, canSwapPages: !!spread && !!template && hasFacingPages(template.format) && sequence?.spreads[index]?.span === 'spread' && canSwapPages(spread, template.spreads),
    sidebar: !panels.leftHidden, inspector: !panels.rightHidden, sources: !panels.bottomHidden, guides: showGuides, layout, zoom, selectedSpread: spreadId, photoView: photoView.value, selectionCount: selectedSpreads.length,
    saving, activeEditor, pageLabels: Object.fromEntries(spreads.map(({ id }, i) => [id, pageLabels[i]])) };
  const menuKey = JSON.stringify(menuState);
  useEffect(() => { void api?.setBookMenuState(menuState); }, [api, menuKey]);
  const undoCommand = commandState('undo', menuState), redoCommand = commandState('redo', menuState);
  const pdfCommand = commandState('export', menuState);

  const format = formatOf(template);
  // The Book check and export report a saved format the template no longer includes.
  // A template with one fixed format offers no choices and ignores the saved one.
  const missingFormat = !!template && Object.keys(template.formats).length > 0 && !!summary?.project.format &&
    !Object.hasOwn(template.formats, summary.project.format);
  const label = (i: number) => sheetLayoutLabel(template?.spreads, spreads[i]) ?? 'Spread ' + (i + 1);
  const pagesLabel = (i: number) => (pageLabels[i].includes('–') ? 'Pages ' : 'Page ') + pageLabels[i];

  useLayoutEffect(() => {
    if (!canvasMotion || performance.timeOrigin + performance.now() >= canvasMotion.start + reorderTiming.duration || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animations: Animation[] = [];
    for (const offset of canvasMotion.offsets) {
      for (const node of stage.current?.querySelectorAll<HTMLElement>('[data-canvas-spread="' + CSS.escape(offset.spread) + '"]') ?? []) {
        if (node.closest('[data-canvas-hover]')) continue;
        const animation = animateReorder(node, offset);
        animation.startTime = canvasMotion.start - performance.timeOrigin;
        animations.push(animation);
      }
    }
    return () => animations.forEach(animation => animation.cancel());
  }, [canvasMotion, spreadId, spreadSelected, showGuides, activeBox, editKey]);

  const chooseSource = useLiveCallback(choose);
  const adoptSource = useLiveCallback((next: ProjectSummary) => adopt(next));
  const importSources = useLiveCallback(act);
  const importSourcePaths = useLiveCallback((files: File[]) => {
    const paths = api?.pathsForFiles(files) ?? [];
    if (paths.length) importFiles({ paths });
  });
  // The Assets tab lists the files of the template's file parameters, and imports only files of those types.
  const fileTypes = useMemo(() => fileExtensions(template), [template]);
  const importFileRequest = useLiveCallback((files?: File[]) => {
    const paths = files && api?.pathsForFiles(files);
    if (files && !paths?.length) return;
    importFiles({ kind: 'file', accept: fileTypes, ...(paths ? { paths } : {}) });
  });
  const updatePhotoView = useLiveCallback(photoView.update);
  const commandPhotoView = useLiveCallback(photoView.command);
  const customPhotoView = useLiveCallback(photoView.custom);
  const sourcesView = useMemo(() => ({ value: photoView.value, update: updatePhotoView, command: commandPhotoView, custom: customPhotoView, dialog: false }),
    [photoView.value, updatePhotoView, commandPhotoView, customPhotoView]);
  const editFromPanel = useLiveCallback(edit);
  const selectFromPanel = useLiveCallback(select);
  const quickSource = useLiveCallback(() => { if (selectedSource) setQuick(selectedSource); });
  const openInspectorOwner = useLiveCallback((owner: Parameters<typeof openOwner>[1]) => {
    if (spread) { reveal(spread.id); openOwner(spread.id, { ...owner, page: selectedPage }); }
  });
  const openInspectorTarget = useLiveCallback((target: InspectorTarget) => {
    const live = geometry?.targets.find(item => targetKey(item) === targetKey(target));
    if (live) { reveal(live.spread); openTarget(live, true); }
  });
  const placeInspector = useLiveCallback((from: KeptItem, to: ContentTarget) => { if (spread) place(spread.id, from, to); });
  const targetsKey = JSON.stringify(inspectorTargets(geometry?.targets ?? [], spread?.id, selectedPage));
  const panelTargets: InspectorTarget[] = useMemo(() => JSON.parse(targetsKey), [targetsKey]);
  const sourcesPanel = useMemo(() => (summary && <Sources view={sourcesView} summary={summary} tab={sourceTab} setTab={setSourceTab}
          selected={selectedSource ? { [selectedSource.kind]: selectedSource.id } : {}} choose={chooseSource}
          failure={setError} changed={adoptSource} usage={usage} writable={writable} busy={!!busy} importSources={importSources} quickLook={setQuick}
          importPaths={importSourcePaths} fileTypes={fileTypes} importFileRequest={importFileRequest} />),
    [summary, sourcesView, sourceTab, selectedSource, usage, writable, busy, chooseSource, adoptSource, importSources, importSourcePaths, fileTypes, importFileRequest]);
  const inspectorPanel = useMemo(() => (summary && spread && <Inspector summary={summary} writable={writable}
        spread={spread} page={selectedSide ?? selectedPage} source={selectedSource} template={template} render={render ?? lastReady}
        usage={usage} quickLook={quickSource} focus={focusBox}
        targets={panelTargets}
        open={openInspectorOwner}
        openTarget={openInspectorTarget} place={placeInspector} chooseLayout={chooseInspectorLayout}
        holdPreviews={!render && !!lastReady}
        familyPicker={template && layoutFamily && <LayoutFamilyPicker
          key={JSON.stringify([summary.handle, spread.id, selectedPage, layoutFamily, summary.templateHash, template.format, summary.network])}
          project={summary.id} template={template} spread={spread} page={selectedPage} chooseLayout={chooseInspectorLayout} params={summary.project.params} family={layoutFamily}
          readOnly={!writable} blocked={previewNotice || undefined} />}
        edit={editFromPanel} highlight={setHighlight} select={selectFromPanel} />),
    [summary, spread, selectedSide, selectedPage, sequence, index, writable, selectedSource, template, render, lastReady, usage, focusBox, panelTargets, layoutFamily, previewNotice, quickSource, openInspectorOwner, openInspectorTarget, placeInspector, chooseInspectorLayout, editFromPanel, selectFromPanel]);

  const nativeDocumentTitle = navigator.platform.includes('Mac');
  return <ProjectFilesContext.Provider value={projectFiles}><div className={(nativeDocumentTitle ? 'studio mac-studio' : 'studio') + (busyCursor ? ' is-busy' : '')}>
    <div className="editor-shell">
    <header className="toolbar">
      <div className="toolbar-actions project-context">
        <button className="toolbar-icon" aria-label="Toggle project panel" aria-pressed={!panels.leftHidden} title="Toggle project panel (⌃⌘S)" onClick={() => togglePanel('left')}><Icon name="sidebarLeft" /></button>
        {!nativeDocumentTitle && <div className="project-identity" title={summary?.folder}
          onContextMenu={(event) => { event.preventDefault(); void api?.documentProxy('path'); }}
          onClick={(event) => { if (event.metaKey) void api?.documentProxy('path'); }}>
          {summary && <button type="button" className="document-proxy" aria-label="Document location" title="⌘-click for location · Drag to Finder"
            draggable onDragStart={(event) => { event.preventDefault(); void api?.documentProxy('drag'); }}
            onClick={(event) => { event.stopPropagation(); void api?.documentProxy('path'); }}><Icon name="book" size={14} /></button>}
          <span className="document-title">{summary ? bookName(summary.folder) : 'ImageFlow'}</span>
        </div>}
        {summary && <div className="history">
          <button aria-label="Undo" title={undoCommand.label} disabled={!undoCommand.enabled} onClick={() => undo('undo')}><Icon name="undo" /></button>
          <button aria-label="Redo" title={redoCommand.label} disabled={!redoCommand.enabled} onClick={() => undo('redo')}><Icon name="redo" /></button>
        </div>}
      </div>
      <div className="toolbar-actions">
        <button className="toolbar-icon" aria-label="Presentation" title="Presentation (⇧W)" disabled={!summary || !!editing || !!cropping} onClick={() => act('presentation')}><Icon name="play" /></button>
        <div className="export-area">
          {/* One button in one place: exporting changes its label and makes it cancel, so the toolbar never moves. The
              stages show in the status bar. */}
          <button className="export-button" data-exporting={exporting || undefined} disabled={!exporting && !pdfCommand.enabled}
            title={exporting ? 'Cancel export' : 'Export PDF… (⌘E)'} aria-label={exporting ? 'Exporting, cancel export' : undefined}
            onClick={() => { if (exporting) void api?.cancelExport(); else act('export'); }}>
            {exporting ? <span className="status-spinner" aria-hidden="true" /> : <Icon name="export" />}<span>{exporting ? 'Exporting…' : 'Export PDF…'}</span>
          </button>
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
        <div ref={projectContent} className="project-panel-content" style={{ '--settings-height': settingsHeight + 'px' } as CSSProperties}>
        <div className="project-head">

          <p className="muted" title={summary?.folder}>{summary ? (sequence ? sequence.count + ' pages · ' + spreads.length + ' spreads' : 'Loading book…') : ''}</p>
        </div>
        {summary && template && <PanelSection id="project.settings" title="Book settings" state={bookSettings} className="document-settings template-controls">
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
        </PanelSection>}
        {summary && template && bookSettings[0] && <PanelDivider side="settings" size={settingsHeight} maximum={settingsMaximum} resize={resizeSettings} onResizing={setResizing} />}
        {summary && <>
          <div className="spread-bar">
            <span className="eyebrow">Spreads</span>
            <div className="icon-actions">
              <button aria-label="Add" title="Add spread" disabled={!canAdd} onClick={() => add()}><Icon name="add" /></button>
              <button aria-label="Duplicate" title={selectedSpreads.length > 1 ? `Duplicate ${selectedSpreads.length} spreads` : 'Duplicate spread'} disabled={!canDuplicate}
                onClick={() => { if (selectedSpreads.length > 1) duplicateSelected(selectedSpreads); else add(true); }}><Icon name="duplicate" /></button>
              <button aria-label="Move spread up" title="Move up (⌥⌘↑)" disabled={!canMoveUp} onClick={() => moveSelected(selectedSpreads, 'up')}><Icon name="up" /></button>
              <button aria-label="Move spread down" title="Move down (⌥⌘↓)" disabled={!canMoveDown} onClick={() => moveSelected(selectedSpreads, 'down')}><Icon name="down" /></button>
              <button aria-label="Delete" title={selectedSpreads.length > 1 ? `Delete ${selectedSpreads.length} spreads` : 'Delete spread'} disabled={!canDelete}
                onClick={() => deleteSelected(selectedSpreads)}><Icon name="delete" /></button>
            </div>
          </div>
          <div ref={thumbScroll} className="thumbs-scroll" onScroll={measureThumbnails} onDragOver={reorder.over} onDragLeave={reorder.leave} onDrop={reorder.drop}>
            <div ref={thumbList} className={(thumbs ? 'spread-thumbs placed' : 'spread-thumbs') + (opening ? ' opening' : '')} style={{ height: thumbs?.height }}
              role="group" aria-label="Spreads" onKeyDown={thumbKeys}>
              {spreads.map(({ id }, i) => {
                const rect = thumbs?.sheets.find(({ spread }) => spread === id);
                const displayedLabel = canvasLabels[id] ?? pagesLabel(i) + ' · ' + label(i);
                const displayedPages = displayedLabel.split(' · ')[0].replace(/^Pages? /, '');
                const level = spreadIssues.get(id);
                return <button key={id} data-list-id={id} data-spread={id}
                  aria-pressed={spreadSelected && (awaitingSelection ? id === outlined : selectedSpreads.includes(id))} aria-current={spreadSelected && index === i ? 'page' : undefined} aria-label={displayedLabel}
                  title={displayedLabel + (level ? ' · ' + (level === 'error' ? 'Has errors' : 'Has warnings') : '')}
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
                    <span className="pages">{displayedPages}</span>
                    <span className="name">{label(i)}</span>
                  </span>
                </button>;
              })}
              {reorder.indicator && <div className="spread-insertion" aria-hidden="true" style={{ top: reorder.indicator.top }} />}
              <BookFrame busy={busyCursor} reuse={fasterUpdates} project={summary.id} view="thumbs" onPrepared={pairFrames ? (id) => preparedView(id, 'thumbs') : undefined} onShown={(id) => preparedView(id, 'thumbs')}
                release={frameRelease} title="Spread thumbnails" onGeometry={setThumbs}
                viewport={thumbnailViewport} hold={holdPreview} accept={acceptCandidate} />
            </div>
          </div>
        </>}
        </div>
      </aside>
      {!panels.leftHidden ? <PanelDivider side="left" size={panels.left} resize={resizePanel} onResizing={setResizing} /> : <div />}
      <div className="workspace-center">
        <div ref={canvasWrap} className="canvas-wrap">
          {summary && <div className="canvas-zoom-controls" role="toolbar" aria-label="Book zoom">
            <button type="button" aria-label="Zoom book out" title="Zoom out (⌘−)" disabled={!canvasReady || zoom <= .3}
              onClick={() => setZoom((value) => value / 1.2)}><Icon name="minus" /></button>
            <span className="canvas-zoom-value" title={zoom > 1 ? 'Zoom relative to Fit. Hold Space and drag to pan.' : 'Zoom relative to the fitted view'}>{zoom === 1 ? 'Fit' : Math.round(zoom * 100) + '%'}</span>
            <button type="button" aria-label="Zoom book in" title="Zoom in (⌘+)" disabled={!canvasReady || zoom >= 3}
              onClick={() => setZoom((value) => value * 1.2)}><Icon name="plus" /></button>
            {zoom !== 1 && <button type="button" className="canvas-return-fit" onClick={() => setZoom(1)} title="Restore the fitted view and reading position">Return to Fit</button>}
          </div>}
          <main ref={canvas} className={'canvas' + (geometry?.columns ? ' canvas-grid' : '')} aria-label="Book preview" tabIndex={0} aria-busy={updating || undefined} data-zoomed={zoom > 1 || undefined}
            data-pan-ready={canvasGestures.panReady || undefined} data-panning={canvasGestures.panning || undefined} onScroll={() => { rememberViewAnchor(); measureView(); }}
            onContextMenu={(event) => void canvasMenu(event)} onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} onKeyDown={(event) => {
              delete event.currentTarget.dataset.pointerFocus;
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void spreadMenu(spreadId, [spreadId], selectedSide); } else { spreadDeleteKey(event); canvasArrowKeys(event); }
            }} onPointerDown={(event) => {
              if (!(event.target as HTMLElement).closest('input, textarea, select, button, [contenteditable]')) event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.dataset.pointerFocus = '';
            }}
            onDragOver={(event) => {
              if (!writable || !canvasReady || !event.dataTransfer.types.some((type) => type === 'Files' || type === photoMime || type === textMime || type === layoutMime)) return;
              event.preventDefault();
              const { box } = locate(event, event.dataTransfer.types);
              setDropTarget(box ? box.spread + ':' + (box.page ? box.page + ':' : '') + box.id : undefined);
            }} onDragLeave={() => setDropTarget(undefined)} onDrop={drop}>
            {summary && !spreads.length && <EmptyBook template={template} writable={writable && !busy} start={start} />}
            {summary && <div ref={stage} className="stage"
              // A grid fills the canvas width; the frame reports the height of all its rows.
              style={{ '--canvas-fit-width': columns ? '100cqw' : undefined, height: geometry?.height,
                '--canvas-zoom': zoom,
                '--aspect': format ? format.spreadWidth / format.height : undefined } as CSSProperties}
              onClick={(event) => {
                // A click that ended a photo move is not a click.
                if (moved.current) return;
                const { sheet, side, top, target } = locate(event);
                if (!sheet || !spreads.some(({ id }) => id === sheet)) return;
                // Select the clicked page first, even when one image spans both halves. Only a click on the
                // already selected page opens its content editor.
                const current = spreadSelected && spreadId === sheet && (selectedLayoutMode === 'page' || selectionSide === side);
                select(sheet, false, side);
                // A held editor blocks clicks while the preview is out of date. A click on another field that replays once
                // the held one applied its text (InlineTextEditor) opens that field when the book shows the save: the held
                // editor's context then differs only by its own change.
                const showsCurrent = canvasReady && readyId.current === summary?.id;
                if (!current || (blockedInline && (!showsCurrent || (target && targetKey(target) === editing?.key)))) return;
                if (top) setFocusBox({ box: top.id, at: Date.now() });
                // What is drawn on top decides: a box or element opens its own editor there (see openOwner). A smaller
                // click-to-edit node on top, such as a heading over a photo, opens its popover instead.
                const own = !target || (!!top && target.page === top.page && (target.edits.every((path) =>
                  path.startsWith((top.type === 'element' ? 'elements.' : 'boxes.') + top.id + '.')) ||
                  (target.owner?.id === top.id && (target.owner.type === 'element') === (top.type === 'element'))));
                if (target?.inlineText) openTarget(target);
                else if (top && own) openOwner(top.spread, { type: top.type, id: top.id, page: top.page });
                else if (target && !openDocumentEditor(target, clickAt(event, target))) openEditing({ spread: target.spread, key: targetKey(target) });
              }}
              onDoubleClick={(event) => {
                // Double-clicking a Markdown box shows its text in Quick Look.
                const { top } = locate(event);
                const source = top?.type === 'markdown' && boxSource(top.spread, top.id, top.page);
                if (source) setQuick(source);
              }}
              onPointerDown={(event) => {
                // Pressing an unselected photo may start moving it to another box (the selected one pans instead).
                if (event.button !== 0 || !writable || busy) return;
                const { top } = locate(event);
                const photo = top?.type === 'photo' && scopeSpread(spreads.find(({ id }) => id === top.spread), top.page)?.boxes[top.id]?.photo;
                pendingMove.current = photo ? { spread: top.spread, box: top.id, page: top.page, photo, x: event.clientX, y: event.clientY } : undefined;
              }}
              >
              <div className="canvas-artwork-clip">
                <div className="canvas-artwork">
                  <BookFrame busy={busyCursor} reuse={fasterUpdates} project={summary.id} view="book" onPrepared={pairFrames ? (id) => preparedView(id, 'book') : undefined} onShown={(id) => preparedView(id, 'book')}
                    release={frameRelease} title="Book preview" cropPreview={cropPreview} onGeometry={setCanvasGeometry} onStatus={bookStatus} onPictures={bookPictures}
                    viewport={frameViewport} hold={holdPreview} accept={acceptCandidate} inlineEditing={inlineEditing}
                    onInlineEditing={(key) => { if (leavingEditor && key === 'null') leaveEditor(); }} />
                </div>
              </div>
              {geometry?.sheets.map(({ spread: id, x, y, width }) => {
                const level = spreadIssues.get(id);
                const at = spreads.findIndex(sheet => sheet.id === id);
                const displayedLabel = canvasLabels[id] ?? (at >= 0 ? pagesLabel(at) + ' · ' + label(at) : id);
                return <div key={id} data-canvas-spread={id} className={'sheet-label' + (spreadSelected && id === outlined ? ' selected' : '')} style={{ left: x, top: y - 26, width }}>
                  {level && <span className={'issue-dot issue-' + level} />}<span className="sheet-label-name" title={displayedLabel}>{displayedLabel}</span>
                  {spreadSelected && id === outlined && <span className="sheet-layout-mode" data-layout-mode={selectedLayoutMode} aria-label={selectedLayoutMode === 'pages' ? 'Two page layouts' : selectedLayoutMode === 'spread' ? 'Spread layout' : 'Single page'} title={selectedLayoutMode === 'pages' ? 'Two page layouts' : selectedLayoutMode === 'spread' ? 'Spread layout' : 'Single page'}>
                    <Icon name={selectedLayoutMode === 'pages' ? 'pageLayouts' : selectedLayoutMode === 'spread' ? 'spreadLayout' : 'pageLayout'} size={16} activeSide={selectionSide} />
                  </span>}
                </div>;
              })}
              <CanvasHover key={hoverEpoch} stage={stage} geometry={geometry} selected={spreadSelected} spread={outlined || spread?.id}
                editKey={editKey} cropping={!!cropping} locate={locate} motion={canvasMotion} />
              {facingSheet && <div data-canvas-spread={facingSheet.spread} className="facing-page-selection" aria-hidden="true" style={{
                left: facingSheet.x, top: facingSheet.y, width: facingSheet.width, height: facingSheet.height }} />}
              {selectedSheet && <div data-canvas-spread={selectedSheet.spread} data-layout-mode={selectedLayoutMode} className="sheet-selection" aria-hidden="true" style={{
                left: selectedSheet.x, top: selectedSheet.y, width: selectedSheet.width, height: selectedSheet.height }} />}
              {activeSpreadPage && <div data-canvas-spread={activeSpreadPage.spread} data-page={selectionSide} className="active-spread-page" aria-hidden="true" style={{
                left: activeSpreadPage.x, top: activeSpreadPage.y, width: activeSpreadPage.width, height: activeSpreadPage.height }} />}
              {showGuides && format && geometry?.sheets.map((sheet) => <Guides key={sheet.spread} sheet={sheet} format={format} />)}
              {activeBox && <div data-canvas-spread={activeBox.spread} className="box-highlight" aria-hidden="true" style={{
                left: activeBox.x, top: activeBox.y, width: activeBox.width, height: activeBox.height,
              }} />}
              {moving && summary?.photos[moving.photo] && <img className="photo-move-ghost" src={summary.photos[moving.photo]} alt=""
                style={{ left: moving.x, top: moving.y }} />}
              {cropping && cropFrame && cropPhoto && summary && <CropEditor key={cropping.spread + ':' + cropping.box}
                frame={cropFrame} photo={summary.photoSizes[cropPhoto]} src={renderOrigin + '/render/' + summary.id + '/photo/' + cropPhoto}
                placement={cropPlacement} settling={!!cropping.settling}
                inchesPerPixel={format && cropSheet ? format.spreadWidth / cropSheet.width / 25.4 : undefined}
                resolution={template?.format.output.resolution} save={saveCrop} close={deselectPhoto}
                custom={!!cropFrame.custom} preview={(placement) => setCropPreview(placement && { spread: cropping.spread, box: cropping.box, page: cropping.page, placement })}
                toolbarHost={canvasWrap.current}>
                {/* The box's photo and its own parameters (such as Show caption) sit with the selected photo. Replacing or
                    removing the photo ends the selection. */}
                {cropState && summary && <div className="crop-params crop-content">
                  <PhotoContent summary={summary} spread={scopeSpread(spreads.find(({ id }) => id === cropping.spread), cropping.page)!} box={cropping.box} compact values
                    label={cropBox?.label ?? cropping.box} assigned={deselectPhoto}
                    change={(update, notice) => changeSpreadAt(cropping.spread, update, notice, cropping.page)} />
                </div>}
                {cropBox && Object.keys(cropBox.parameters).length > 0 && <div className="crop-params">
                  <Fields compact schema={cropBox.parameters} controls={cropBox.controls} values={cropState?.params ?? {}} update={(key, value) => edit(({ project }) => {
                    const state = editableSpread(project.spreads.find(({ id }) => id === cropping.spread), cropping.page);
                    if (state?.definition !== cropping.layout || state.boxes[cropping.box]?.photo !== cropPhoto) return;
                    state.boxes[cropping.box].params[key] = value;
                  }, cropBox.parameters[key].label + ' updated')} />
                </div>}
                {cropAttached.length > 0 && <div className="crop-params">
                  <MarkedFields compact project={summary.project} spread={spreads.find(({ id }) => id === cropping.spread)!} page={cropping.page} template={template!}
                    edits={cropAttached} edit={(change, notice) => edit((files) => {
                      if (editableSpread(files.project.spreads.find(({ id }) => id === cropping.spread), cropping.page)?.definition === cropping.layout) change(files);
                    }, notice)} />
                </div>}
              </CropEditor>}
              {editing && inline && summary && textInline && <InlineTextEditor key={editing.session}
                projectId={summary.id} project={summary.project} spread={editSpread ?? { ...inline.spread, definition: '' }} template={template ?? inline.template} target={inline.target}
                zoom={editSheet?.zoom ?? 1} host={canvasWrap.current} canvasReady={canvasReady} blocked={blockedInline || undefined}
                edit={edit} close={closeEditor} step={stepEditor} shown={setTextShown} notice={setNotice} />}
              {editing && inline && summary && !textInline && <EditPopover key={editing.session}
                compact={editing.owner?.type === 'markdown'} anchor={() => {
                  const stageRect = stage.current?.getBoundingClientRect(), host = canvasWrap.current?.getBoundingClientRect();
                  return stageRect && host ? { x: stageRect.left - host.left + inline.target.x, y: stageRect.top - host.top + inline.target.y, width: inline.target.width, height: inline.target.height } : undefined;
                }} project={inline.project} spread={inline.spread} page={inline.target.page} template={inline.template} edits={inline.target.edits} host={canvasWrap.current}
                textFallback={inline.target.textFallback}
                note={smallText ? <>
                  <span>{textZoom ? 'This text is too small to edit on the page at this zoom.' : 'This text is too small to edit on the page.'}</span>
                  {textZoom && <button type="button" onClick={() => {
                    reopenText.current = { spread: editing.spread, key: editing.key, page: inline.target.page };
                    closeEditor();
                    setZoom(textZoom);
                  }}>Zoom In to Edit on Page</button>}
                </> : undefined}
                blocked={blockedInline || undefined}
                edit={editInline} close={closeEditor} step={stepEditor} title={editing.owner && ownerLabel(inline.spread, editing.owner)}
                actions={!editing.owner && editPhotoBox && !cropBlocked(editing.spread, editPhotoBox)
                  ? <button type="button" onClick={() => startCrop(editing.spread, editPhotoBox, inline.target.page)}>Adjust crop…</button>
                  : editElement && editorOf(editing.spread, editElement)
                    ? <button type="button" onClick={() => openElementEditor(editing.spread, editElement, inline.target.page)}>
                      {(editorOf(editing.spread, editElement)!.label ?? 'Open editor') + '…'}</button> : undefined}>

                {editing.owner?.type === 'photo' && <PhotoContent summary={summary} spread={scopeSpread(inline.spread, inline.target.page)!} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose} values={!!boxSource(editing.spread, editing.owner.id, inline.target.page)}
                  adjustCrop={cropBlocked(editing.spread, editing.owner.id, inline.target.page) ? undefined : () => startCrop(editing.spread, editing.owner!.id, inline.target.page)} />}
                {editing.owner?.type === 'markdown' && <TextContent compact quickLook={setQuick} summary={summary} spread={scopeSpread(inline.spread, inline.target.page)!} box={editing.owner.id}
                  label={ownerLabel(inline.spread, editing.owner)} change={changeSpreadInline} inspect={choose}
                  flow={readyFlow?.[editing.spread + ':' + (inline.target.page ? inline.target.page + ':' : '') + editing.owner.id]}
                  importText={() => importFiles({ kind: 'markdown', target: { spread: editing.spread, box: editing.owner!.id, page: inline.target.page } })} />}
              </EditPopover>}
            </div>}
            {!summary && <p className="book-loading" role="status">{error || 'Opening book…'}</p>}
          </main>
          {summary && (previewNotice || !geometry) && <div className={geometry ? 'preview-state' : 'preview-message'} role="status">
            {previewNotice || 'Rendering book…'}
          </div>}
        </div>
        {summary && (!panels.bottomHidden ? <PanelDivider side="bottom" size={panels.bottom} maximum={bottomMaximum} resize={resizePanel} onResizing={setResizing} /> : <div />)}
        <div className="sources-host" inert={panels.bottomHidden} aria-hidden={panels.bottomHidden}>
        {sourcesPanel}
        </div>
      </div>
      {summary && (!panels.rightHidden ? <PanelDivider side="right" size={panels.right} resize={resizePanel} onResizing={setResizing} /> : <div />)}
      <div className={'inspector-host' + (panels.rightHidden ? ' is-collapsed' : '')} inert={panels.rightHidden} aria-hidden={panels.rightHidden || !summary}>
    {inspectorPanel}
      </div>
    </div>
    {summary && template && elementEditor && !editorTargetGone(spreads, elementEditor) &&
      <ElementEditorDialog host={canvasWrap.current} key={JSON.stringify(elementEditor)} project={summary.id} template={template}
        presentation={elementEditor.presentation} placement={placement} click={elementEditor.click} stage={stage.current} shown={setInlineShown}
        spread={spreads.find(({ id }) => id === elementEditor.spread)!} params={summary.project.params} target={elementEditor}
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
      <span title={issue || busy || notice || undefined} className={issue ? 'status status-error' : busy || updating ? 'status status-busy' : 'status'} role={issue && !summary ? 'alert' : 'status'}>
        {!issue && (busy || updating) && <span className="status-spinner" aria-hidden="true" />}{issue || busy || notice || (updating ? updatingText : '')}
      </span>
      {exporting && <button type="button" className="status-cancel" onClick={() => void api?.cancelExport()}>Cancel</button>}
      <AgentStatus api={api} />
      {summary && <BookCheckIndicator requestSpread={checkScope} request={checkRequest} check={check} checking={!checkCurrent} spread={spreadSelected ? spread?.id ?? '' : ''} select={(id, page) => select(id, true, page)} />}
    </footer>
    </div>
  </div></ProjectFilesContext.Provider>;
}
