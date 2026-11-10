import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import { bookLayout, renderOrigin } from './desktop';
import type { BookGeometry, Command, ImportRequest, Issue, ProjectSummary, Rect, RenderStatus, TemplateInfo } from './desktop';
import { BookFrame } from './BookFrame';
import { revealIn } from './reveal';
import { EditPopover } from './EditPopover';
import { CropEditor } from './CropEditor';
import { ElementEditorDialog } from './ElementEditor';
import { ProjectFilesContext } from './Fields';
import { centered, getCrop, placementIn, placementOf, setPlacement } from './spread';
import type { Placement } from './spread';
import { assignmentCounts, newSpread, sourceUsage } from './editing';
import { moveContent } from './layouts';
import { Fields } from './Fields';
import { Inspector } from './Inspector';
import type { BookCheck, Edit } from './Inspector';
import { QuickLook, Sources } from './Sources';
import { keptMime, photoMime, sourceList, sourceTitle, textMime } from './source-items';
import type { SourceKind, SourceRef } from './source-items';
import { pageSequence, resolveFormat } from './format';
import type { ResolvedFormat } from './format';
import type { ProjectFiles } from './project';

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

const icons = {
  add: 'M8 3v10M3 8h10',
  duplicate: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  delete: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
};
const Icon = ({ name }: { name: keyof typeof icons }) => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <path d={icons[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
</svg>;

export function App() {
  const api = window.imageflow;
  const [summary, setSummary] = useState<ProjectSummary>();
  const current = useRef<ProjectSummary>(undefined);
  const [spreadId, setSpreadId] = useState('');
  const [template, setTemplate] = useState<TemplateInfo>();
  const [render, setRender] = useState<RenderStatus>();
  // The last finished render. The Inspector keeps showing its flow positions while an edit re-renders, so lines
  // like "Flow 1 of 2" do not vanish for a moment and shift the panel.
  const [lastReady, setLastReady] = useState<RenderStatus>();
  const [geometry, setGeometry] = useState<BookGeometry>();
  const [thumbs, setThumbs] = useState<BookGeometry>();
  const [inView, setInView] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string>();
  const [hoveredTarget, setHoveredTarget] = useState<string>();
  const [editing, setEditing] = useState<{ spread: string; key: string }>();
  // Crop mode for one photo box. After a commit, `settling` holds the project id the edit started from; the
  // overlay stays until the book has re-rendered, so the frame does not flash back to the old crop.
  // `layout` is the spread's layout when crop mode opened: each layout has its own crop.
  const [cropping, setCropping] = useState<{ spread: string; box: string; layout: string; settling?: string }>();
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
  const history = useRef<{ past: ProjectFiles[]; future: ProjectFiles[] }>({ past: [], future: [] });
  const spreads = summary?.project.spreads ?? [];
  const index = Math.max(0, spreads.findIndex(({ id }) => id === spreadId));
  const spread = spreads[index];
  const sequence = template && pageSequence(spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const pageLabels = spreads.map((_, i) => {
    const pages = sequence?.spreads[i]?.page;
    return pages?.left && pages?.right ? pages.left + '–' + pages.right : String(pages?.left ?? pages?.right ?? '');
  });
  const writable = !!summary && !summary.readOnly;

  function adopt(next: ProjectSummary, reset = false, selected?: string) {
    current.current = next;
    if (reset) {
      history.current = { past: [], future: [] };
      setTemplate(undefined);
      setSelectedSource(undefined);
      setQuick(undefined);
      setLastReady(undefined);
      setCropping(undefined);
      setEditing(undefined);
      canvas.current?.scrollTo({ top: 0 });
    }
    setSpreadId((previous) => selected ?? (reset ? next.project.spreads[0].id :
      next.project.spreads.find(({ id }) => id === previous)?.id ?? next.project.spreads[0].id));
    if (selected) pendingReveal.current = selected;
    setRender(undefined);
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

  // `notice` may be a function, read after the change ran, for notices that describe what the change found.
  function edit(change: Edit, notice?: string | (() => string), selected?: string) {
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
      setNotice((typeof notice === 'function' ? notice() : notice) ?? 'Saved');
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
    return new Promise<string | undefined>((resolve) => enqueue(async () => {
      try {
        const before = current.current;
        if (!api || !before || before.readOnly) return resolve(undefined);
        setBusy('Importing file…');
        const result = await api.importFiles(before.id, { kind: 'file', accept });
        if ('error' in result) throw new Error(result.error);
        if (!result.value) return resolve(undefined);
        adopt(result.value.summary);
        resolve(result.value.imported[0]);
      } catch (error) {
        resolve(undefined);
        throw error;
      }
    }));
  }
  // importParameterFile only reads refs, the preload API and state setters, so it may be kept from the first render.
  const projectFiles = useMemo(() => ({ files: summary?.project.files ?? {}, importFile: importParameterFile }), [summary?.project.files]);

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
        // The export rendered the whole book; its result is the complete Book check for that project state.
        const { errors, warnings } = result.value;
        const counted = (n: number, word: string) => n ? n + ' ' + word + (n === 1 ? '' : 's') : '';
        const found = [counted(errors.length, 'error'), counted(warnings.length, 'warning')].filter(Boolean).join(', ');
        setNotice((command === 'print' ? 'Print PDF saved.' : 'Proof PDF saved.') + (found ? ' ' + found + ' in Book check.' : ''));
        if (before.id === current.current?.id) setCheck({ id: before.id, errors, warnings });
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
    // In dev mode a full page reload or main-process restart would drop the open project; reopen it.
    if (import.meta.env.DEV) {
      void api.openProject('reload').then((result) => { if ('value' in result && result.value) adopt(result.value, true); });
    }
    return () => { command(); changed(); progress(); };
  }, [api]);

  // The book frame renders every spread, so its status doubles as the book check.
  function bookStatus(status: RenderStatus, id: string) {
    if (id !== current.current?.id) return;
    setRender(status);
    if (status.state === 'ready') setLastReady(status);
    setCropping((previous) => previous?.settling && previous.settling !== id ? undefined : previous);
    if (status.template) setTemplate(status.template);
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
    return () => window.removeEventListener('resize', listener);
  }, []);
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
    edit(({ project }) => {
      const state = project.spreads.find(({ id }) => id === spread);
      if (state) state.boxes[box] = { params: state.boxes[box]?.params ?? {}, ...(source.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
    });
  }

  // Moves content a spread keeps outside its layout into one of its boxes; content already there is kept instead.
  function place(spread: string, from: string, to: string) {
    if (!summary || !template) return;
    const state = spreads.find(({ id }) => id === spread);
    const moving = state?.boxes[from];
    const label = state && template.spreads[state.definition]?.boxes[to]?.label;
    if (!moving || !label) return;
    const kind = moving.photo ? 'photo' : 'text';
    let swapped: string | undefined;
    edit(({ project }) => {
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
    if (!editing || !geometry) return;
    const order = geometry.targets.filter(({ spread }) => spread === editing.spread)
      .sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
    const at = order.findIndex((target) => targetKey(target) === editing.key);
    const next = order[(at + direction + order.length) % order.length];
    setEditing(next ? { spread: next.spread, key: targetKey(next) } : undefined);
  }
  const editTarget = editing && geometry?.targets.find((target) => targetKey(target) === editing.key);
  const editSpread = editing && spreads.find(({ id }) => id === editing.spread);
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
  function cropBlocked(spread: string, box: string) {
    const state = spreads.find(({ id }) => id === spread)?.boxes[box];
    const frame = geometry?.boxes.find((rect) => rect.spread === spread && rect.id === box);
    if (!state?.photo || !summary?.photos[state.photo] || !summary.photoSizes[state.photo]) return 'Add a photo to this box first.';
    if (!frame) return 'The book is still rendering.';
    if (!frame.upright) return 'The template rotates or mirrors this frame; use the crop values in the Inspector.';
  }
  function editorOf(spread: string, element: string) {
    const state = spreads.find(({ id }) => id === spread);
    return state && template?.spreads[state.definition]?.elements[element]?.editor;
  }
  function openElementEditor(spread: string, element: string) {
    if (!editorOf(spread, element)) return false;
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
  function commitCrop(placement: Placement) {
    if (!cropping || cropping.settling || !cropFrame || !cropPhoto || !summary) return;
    const size = summary.photoSizes[cropPhoto];
    const aspect = cropFrame.width / cropFrame.height;
    const normal = (value: Placement) => JSON.stringify(placementOf(getCrop(size, value, aspect), value.zoom));
    if (normal(placement) === normal(cropPlacement ?? centered)) {
      setCropping(undefined);
      return;
    }
    const fits = normal(placement) === normal(centered);
    const { spread, box, layout } = cropping;
    edit(({ project }) => {
      const state = project.spreads.find(({ id }) => id === spread);
      const target = state?.boxes[box];
      // Crop mode closes when the layout changes; never save a crop into a layout it was not made for.
      if (!target?.photo || state?.definition !== layout) return;
      setPlacement(target, layout, fits ? centered : placement);
    }, 'Crop updated');
    setCropping({ spread, box, layout, settling: summary.id });
  }
  // If the save fails, there is no re-render to wait for.
  useEffect(() => {
    if (!cropping?.settling) return;
    const timer = setTimeout(() => setCropping(undefined), 4000);
    return () => clearTimeout(timer);
  }, [cropping?.settling]);

  // Changing a spread's layout (including by Undo) ends crop mode and closes the edit popover on that spread, so
  // neither saves into a layout it was not opened for. Element editors notice through their own stale check.
  const layouts = useRef(new Map<string, string>());
  useEffect(() => {
    const changed = new Set(spreads.filter(({ id, definition }) => layouts.current.has(id) && layouts.current.get(id) !== definition)
      .map(({ id }) => id));
    layouts.current = new Map(spreads.map(({ id, definition }) => [id, definition]));
    if (!changed.size) return;
    setCropping((crop) => crop && changed.has(crop.spread) ? undefined : crop);
    setEditing((open) => open && changed.has(open.spread) ? undefined : open);
  }, [spreads]);

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropTarget(undefined);
    if (!api || !writable || busy || !summary) return;
    const { box } = locate(event);
    // Kept content dropped on its own spread moves; dropped on another spread it is another use of its source.
    const kept = event.dataTransfer.getData(keptMime);
    if (kept && box && box.type !== 'element') {
      const origin = JSON.parse(kept) as { spread: string; box: string };
      if (origin.spread === box.spread) {
        place(origin.spread, origin.box, box.id);
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
    importFiles({ kind, paths, target: box && box.type !== 'element' ? { spread: box.spread, box: box.id } : undefined });
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
  const issue = error || (render?.state === 'error' ? render.message : '');
  // While an edit re-renders, export stays available from the last finished render; a failed render disables it.
  const canExport = (render ?? lastReady)?.state === 'ready' && !busy;
  const counts = summary ? assignmentCounts(summary.project, template?.spreads) : {};
  const format = formatOf(template);
  // A saved format the template's named formats no longer include; the Book check reports it and print export is
  // blocked. A template with one fixed format offers no choices and ignores the saved one.
  const missingFormat = !!template && Object.keys(template.formats).length > 0 && !!summary?.project.format &&
    !Object.hasOwn(template.formats, summary.project.format);
  const label = (definition: string, i: number) => template?.spreads[definition]?.label ?? 'Spread ' + (i + 1);
  const pagesLabel = (i: number) => (pageLabels[i].includes('–') ? 'Pages ' : 'Page ') + pageLabels[i];

  return <ProjectFilesContext.Provider value={projectFiles}><div className="studio">
    <header className="toolbar">
      <div className="toolbar-actions">
        <div className="brand"><span className="brand-icon" aria-hidden="true">◫</span> ImageFlow</div>
        {summary && <div className="history">
          <button disabled={!history.current.past.length || !!busy} onClick={() => undo('undo')}>Undo</button>
          <button disabled={!history.current.future.length || !!busy} onClick={() => undo('redo')}>Redo</button>
        </div>}
      </div>
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
        <div className="project-head">
          <p className="eyebrow">Project</p>
          <h1>{summary?.project.title ?? 'Photobook studio'}</h1>
          <p className="muted">{summary ? summary.folder + (summary.readOnly ? ' · Sample' : '') : 'Local photobook projects'}</p>
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
              <BookFrame project={summary.id} view="thumbs" title="Spread thumbnails" onGeometry={setThumbs} />
            </div>
          </div>
          {template && <div className="format">
            <span>{template.format.label}</span>
            <span className="muted">{sequence?.count} pages · {spreads.length} spreads</span>
          </div>}
        </>}
      </aside>
      <div className="workspace-center">
        <div ref={canvasWrap} className="canvas-wrap">
          <main ref={canvas} className="canvas" aria-label="Book preview" onScroll={measureView}
            onDragOver={(event) => {
              if (!writable || !event.dataTransfer.types.some((type) => type === 'Files' || type === photoMime || type === textMime)) return;
              event.preventDefault();
              const { box } = locate(event, event.dataTransfer.types);
              setDropTarget(box ? box.spread + ':' + box.id : undefined);
            }} onDragLeave={() => setDropTarget(undefined)} onDrop={drop}>
            {summary && <div ref={stage} className="stage"
              style={{ height: geometry?.height, cursor: hoveredTarget ? 'pointer' : undefined,
                '--aspect': format ? format.spreadWidth / format.height : undefined } as CSSProperties}
              onClick={(event) => {
                const { sheet, top, target } = locate(event);
                if (!sheet) return;
                select(sheet, false);
                if (target) setEditing({ spread: target.spread, key: targetKey(target) });
                if (top) setFocusBox({ box: top.id, at: Date.now() });
              }}
              onDoubleClick={(event) => {
                // Acts on what is drawn on top, so an element over a photo opens its editor rather than crop mode.
                const { top } = locate(event);
                if (!top) return;
                // Double-clicking a photo means crop mode; if that is not possible, the status line says why.
                if (top.type === 'photo') {
                  startCrop(top.spread, top.id);
                  return;
                }
                // Double-clicking an element with a template-supplied editor opens it.
                if (top.type === 'element') {
                  openElementEditor(top.spread, top.id);
                  return;
                }
                const source = boxSource(top.spread, top.id);
                if (source) setQuick(source);
              }}
              onMouseMove={(event) => {
                const { sheet, target } = locate(event);
                setHovered(sheet);
                setHoveredTarget(target && targetKey(target));
              }} onMouseLeave={() => { setHovered(undefined); setHoveredTarget(undefined); }}>
              <BookFrame project={summary.id} view="book" title="Book preview" onGeometry={setGeometry} onStatus={bookStatus}
                viewport={viewport} />
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
              {cropping && cropFrame && cropPhoto && summary && <CropEditor key={cropping.spread + ':' + cropping.box}
                frame={cropFrame} photo={summary.photoSizes[cropPhoto]} src={renderOrigin + '/render/' + summary.id + '/photo/' + cropPhoto}
                placement={cropPlacement} settling={!!cropping.settling}
                inchesPerPixel={format && cropSheet ? format.spreadWidth / cropSheet.width / 25.4 : undefined}
                resolution={template?.format.output.resolution} commit={commitCrop} cancel={() => setCropping(undefined)}
                toolbarHost={canvasWrap.current} />}
              {editing && editTarget && editSpread && template && summary && <EditPopover key={editing.key}
                project={summary.project} spread={editSpread} template={template} edits={editTarget.edits} anchor={editTarget}
                bounds={{ width: stage.current?.clientWidth ?? 0 }} readOnly={!writable} edit={edit} close={closeEditor} step={stepEditor}
                actions={editPhotoBox && !cropBlocked(editing.spread, editPhotoBox)
                  ? <button type="button" onClick={() => startCrop(editing.spread, editPhotoBox)}>Adjust crop…</button>
                  : editElement && editorOf(editing.spread, editElement)
                    ? <button type="button" onClick={() => openElementEditor(editing.spread, editElement)}>
                      {(editorOf(editing.spread, editElement)!.label ?? 'Open editor') + '…'}</button> : undefined} />}
            </div>}
            {!summary && <div className="welcome">
              <span className="welcome-icon" aria-hidden="true">◫</span>
              <h2>See your book take shape</h2>
              <p>{api ? 'Create a book with the starter template, open a project you trust, or preview the Senja sample.' :
                'Launch the desktop app to open an ImageFlow project.'}</p>
              {api && <button className="primary" disabled={!!busy} onClick={() => act('sample')}>Try the Senja sample</button>}
            </div>}
            {summary && !geometry && render?.state !== 'error' && <div className="preview-message" role="status">Rendering book…</div>}
            {summary && render?.state === 'error' && <div className="preview-message">Book preview unavailable</div>}
          </main>
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
      {summary && spread && <Inspector summary={summary} spread={spread} source={selectedSource} template={template} render={render ?? lastReady}
        usage={usage} inspectSource={choose} quickLook={() => selectedSource && setQuick(selectedSource)} focus={focusBox}
        targets={geometry?.targets.filter((target) => target.spread === spread.id)}
        adjustCrop={(box) => { reveal(spread.id); startCrop(spread.id, box); }}
        openEditor={(element) => openElementEditor(spread.id, element)} place={(from, to) => place(spread.id, from, to)}
        edit={edit} highlight={setHighlight} issues={issue} check={check} checking={!checkCurrent} select={select}
        importText={(box) => importFiles({ kind: 'markdown', target: { spread: spread.id, box } })} />}
    </div>
    {summary && template && elementEditor && spreads.some(({ id }) => id === elementEditor.spread) &&
      <ElementEditorDialog key={elementEditor.spread + ':' + elementEditor.element} project={summary.id} template={template}
        spread={spreads.find(({ id }) => id === elementEditor.spread)!} element={elementEditor.element} readOnly={!writable}
        edit={edit} close={() => setElementEditor(undefined)} />}
    {summary && quick && <QuickLook summary={summary} source={quick} usage={usage} navigate={navigateQuick}
      close={() => setQuick(undefined)} jump={(id) => select(id)} />}
    <footer className={issue ? 'status status-error' : 'status'} role={issue && !summary ? 'alert' : 'status'}>
      {issue || busy || notice || (summary ? 'Project preview · Proof export' : 'ImageFlow for macOS')}
    </footer>
  </div></ProjectFilesContext.Provider>;
}
