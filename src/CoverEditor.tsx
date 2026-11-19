import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PhotoContent } from './BoxContent';
import { Fields } from './Fields';
import { renderOrigin } from './desktop';
import type { CoverLayoutInfo, ProjectSummary, Rect, RenderStatus } from './desktop';
import type { CoverResolution, ResolvedCover } from './cover';
import type { CoverState } from './project';

type ActiveCover = Exclude<CoverResolution, { status: 'unavailable' }>;
type CoverStatus = { project: string; status: RenderStatus };
const dimension = (mm: number) => Number(mm.toFixed(2));

function CoverGuides({ geometry }: { geometry: ResolvedCover }) {
  const { sheet, trim, folds, safe, avoid } = geometry;
  const position = (rect: Rect) => ({
    left: (rect.x - sheet.x) / sheet.width * 100 + '%',
    top: (rect.y - sheet.y) / sheet.height * 100 + '%',
    width: rect.width / sheet.width * 100 + '%',
    height: rect.height / sheet.height * 100 + '%',
  });
  return <div className="cover-guides" aria-hidden="true">
    <div className="trim-guide" style={position(trim)} />
    {Object.entries(safe).map(([region, rect]) => rect && <div key={region} className="safe-guide" style={position(rect)} />)}
    {folds.map((x) => <div key={x} className="gutter-guide" style={{ left: (x - sheet.x) / sheet.width * 100 + '%', height: '100%' }} />)}
    {avoid.map((rect) => <div key={rect.x} className="cover-fold-avoidance" style={position(rect)} />)}
  </div>;
}

export function CoverCanvas({ project, geometry: cover, definition, guides, toggleGuides, openInspector, onStatus }: {
  project: string; geometry: ActiveCover; definition?: CoverLayoutInfo; guides: boolean;
  toggleGuides: () => void; openInspector: () => void; onStatus: (status: CoverStatus) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [result, setResult] = useState<CoverStatus>();
  const [width, setWidth] = useState(0);
  const { sheet } = cover.geometry;
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const fit = () => setWidth(Math.max(0, Math.min(element.clientWidth, element.clientHeight * sheet.width / sheet.height)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sheet.width, sheet.height]);
  useEffect(() => {
    function receive(event: MessageEvent<RenderStatus>) {
      if (event.origin !== renderOrigin || !frame.current || event.source !== frame.current.contentWindow) return;
      if (event.data?.state !== 'ready' && event.data?.state !== 'error') return;
      const next = { project, status: event.data };
      setResult(next);
      onStatus(next);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [project, onStatus]);
  const status = result?.project === project ? result.status : undefined;
  return <main className="cover-canvas" aria-label="Cover preview">
    <div className="cover-preview-bar">
      <span>{dimension(sheet.width)} × {dimension(sheet.height)} mm <span className="muted">· {cover.interiorPages} content pages</span></span>
      <button type="button" aria-pressed={guides} onClick={toggleGuides}>Guides</button>
    </div>
    {cover.status === 'provisional' && <p className="cover-notice" role="status">
      Draft size based on {cover.previewPages} pages. Adjust the content page count before exporting.
    </p>}
    <div ref={surface} className="cover-preview-surface">
      <div className="cover-preview-sheet" style={{ width, aspectRatio: sheet.width / sheet.height }}
        data-width-mm={dimension(sheet.width)} data-height-mm={dimension(sheet.height)} data-ready={status?.state === 'ready' || undefined}>
        <iframe key={project} ref={frame} src={renderOrigin + '/render/' + encodeURIComponent(project) + '?view=cover'}
          title="Exterior cover artwork" tabIndex={-1} />
        {guides && <CoverGuides geometry={cover.geometry} />}
        {status?.state === 'error'
          ? <p className="cover-preview-message" role="alert">{status.message}</p>
          : !definition ? <button type="button" className="cover-preview-message" onClick={openInspector}>Choose a cover layout</button> : null}
      </div>
    </div>
  </main>;
}

export function CoverInspector({ summary, cover, layouts, writable, choose, change }: {
  summary: ProjectSummary; cover?: CoverState; layouts: Record<string, CoverLayoutInfo>; writable: boolean;
  choose: (layout: string) => void; change: (apply: (cover: CoverState) => void, label?: string) => void;
}) {
  const definition = cover && Object.hasOwn(layouts, cover.definition) ? layouts[cover.definition] : undefined;
  return <aside className="inspector cover-inspector" aria-label="Cover inspector">
    <fieldset disabled={!writable}>
      <label className="field">Cover layout
        <select aria-label="Cover layout" value={definition && cover ? cover.definition : ''} onChange={(event) => choose(event.target.value)}>
          <option value="" disabled>Choose a layout…</option>
          {Object.entries(layouts).map(([id, layout]) => <option key={id} value={id}>{layout.label}</option>)}
        </select>
      </label>
      {definition && cover && <>
        <Fields schema={definition.parameters} values={cover.params} controls={definition.controls}
          update={(id, value) => change((state) => { state.params[id] = value; }, 'Cover text and settings changed')} />
        {Object.entries(definition.boxes).map(([id, box]) => <details key={id} open>
          <summary>{box.label}</summary>
          <PhotoContent summary={summary} spread={cover} box={id} label={box.label} values change={change} />
          <Fields schema={box.parameters} controls={box.controls} values={cover.boxes[id]?.params ?? {}}
            update={(key, value) => change((state) => { (state.boxes[id] ??= { params: {} }).params[key] = value; }, 'Cover photo settings changed')} />
        </details>)}
        {Object.entries(definition.elements).map(([id, element]) => <details key={id}>
          <summary>{element.label}</summary>
          <Fields schema={element.parameters} controls={element.controls} values={cover.elements[id]?.params ?? {}}
            update={(key, value) => change((state) => { (state.elements[id] ??= { params: {} }).params[key] = value; }, 'Cover element changed')} />
        </details>)}
      </>}
    </fieldset>
  </aside>;
}
