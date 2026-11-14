// Compile-time checks of the authoring types, run by `npm run build` (`tsc -p tests/types`). Each
// `@ts-expect-error` is a declaration a template author must be told about; the build fails if it compiles.
import { box, defineTemplate, mm, p, printFormat, Spread, spreadFor } from 'imageflow';
import type { DocumentEditorProps, ElementEditorProps, LayoutPickerProps } from 'imageflow';

const format = printFormat({ label: 'F', trim: { width: mm(100), height: mm(100) }, bleed: mm(0), safe: mm(5),
  pageCount: { min: 2, max: 20, step: 2 }, ends: 'inside-covers' });
// A layout from its own file, typed with a document parameter `foo`.
const imported = spreadFor({ foo: p.string({ label: 'Foo', default: 'bar' }) })({
  label: 'Imported', render: (ctx) => <Spread>{ctx.document.foo.toUpperCase()}</Spread>,
});

// A template that does not declare `foo` cannot use the imported layout, whether its spreads are a record...
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: { a: imported } });
// ...or a function, mixed with layouts from its own builder.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  a: imported,
  b: spread({ label: 'B', render: () => <Spread /> }),
}) });
// Declared, both forms compile, and the builder types `ctx.document` from the template's parameters.
const foo = { foo: p.string({ label: 'Foo', default: 'x' }) };
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, spreads: { a: imported } });
// Document controls name document parameters only.
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, controls: [{ group: 'Text', controls: ['foo'] }], spreads: { a: imported } });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, controls: ['fooo'], spreads: { a: imported } });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, spreads: ({ spread }) => ({
  a: imported,
  b: spread({ label: 'B', render: (ctx) => <Spread>{ctx.document.foo.toUpperCase()}</Spread> }),
}) });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  // @ts-expect-error
  b: spread({ label: 'B', render: (ctx) => <Spread>{ctx.document.foo}</Spread> }),
}) });

// Misspelt properties are rejected in nested declarations too, not only at the top level.
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  // @ts-expect-error
  a: spread({ label: 'A', lable: 'A', render: () => <Spread /> }),
  // @ts-expect-error
  b: spread({ label: 'B', boxes: { foo: { type: 'markdown', label: 'Foo', flowOrdr: 2 } }, render: () => <Spread /> }),
  // @ts-expect-error
  c: spread({ label: 'C', elements: { foo: { label: 'Foo', paramters: {} } }, render: () => <Spread /> }),
  // @ts-expect-error
  d: spread({ label: 'D', boxes: { hero: box.photo('Hero', { show: p.boolean({ label: 'Show', default: true }) }, { controls: ['shw'] }) },
    render: () => <Spread /> }),
  ok: spread({
    label: 'OK',
    boxes: { hero: box.photo('Hero'), text: { type: 'markdown', label: 'Text', flowOrder: 1 } },
    elements: { stamp: { label: 'Stamp', parameters: { show: p.boolean({ label: 'Show', default: true }) }, controls: ['show'] } },
    render: (ctx) => <Spread><ctx.PhotoBox id="hero" /><ctx.MarkdownBox id="text" /><ctx.Element id="stamp" /></Spread>,
  }),
}) });

// Spreads written as plain objects get the same checks. TypeScript reports one error per call, so one call each.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: { a: { label: 'A', lable: 'x', render: () => <Spread /> } } });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: { b: { label: 'B', boxes: { foo: { type: 'markdown', label: 'Foo', flowOrdr: 2 } },
  render: () => <Spread /> } } });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: { c: { label: 'C', elements: { foo: { label: 'Foo', paramters: {} } },
  render: () => <Spread /> } } });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: { ok: { label: 'OK', boxes: { foo: { type: 'markdown', label: 'Foo', flowOrder: 2 } },
  elements: { e: { label: 'E' } }, render: () => <Spread /> } } });

// Exactly one of `format` and `formats`.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, spreads: {} });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, formats: { a: format }, spreads: {} });

// Parameter objects written without `p` are checked by their `type`, wherever parameters are declared.
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  // @ts-expect-error
  a: spread({ label: 'A', parameters: { note: { type: 'string', label: 'Note', default: '', mutliline: true } }, render: () => <Spread /> }),
  // @ts-expect-error
  b: spread({ label: 'B', boxes: { hero: { type: 'photo', label: 'Hero', parameters: { show: { type: 'boolean', label: 'Show', default: true, min: 1 } } } },
    render: () => <Spread /> }),
  // @ts-expect-error
  c: spread({ label: 'C', elements: { e: { label: 'E', parameters: { size: { type: 'number', label: 'Size', default: 1, stp: 1 } } } }, render: () => <Spread /> }),
  ok: spread({ label: 'OK', parameters: { note: { type: 'string', label: 'Note', default: '', multiline: true } }, render: () => <Spread /> }),
}) });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: { accent: { type: 'color', label: 'Accent', default: '#000', placeholdr: 'x' } },
  spreads: {} });

// A document parameter declared differently in the template than in spreadFor(): the layout could receive values its
// type does not allow.
const paper = spreadFor({ paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm'] }) })({
  label: 'Paper', render: (ctx) => <Spread>{ctx.document.paper === 'warm' ? 'warm' : 'never'}</Spread>,
});
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: { paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm', 'white'] }) },
  // @ts-expect-error
  spreads: { paper } });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: { paper: p.number({ label: 'Paper', default: 1 }) }, spreads: ({ spread }) => ({ paper,
  b: spread({ label: 'B', render: () => <Spread /> }) }) });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: { paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm'] }) },
  spreads: { paper } });

const route = {
  zoom: p.number({ label: 'Zoom', default: 1 }),
  size: p.enum({ label: 'Size', default: 'small', options: ['small', 'large'] }),
  note: p.string({ label: 'Note', default: '' }),
};
const doc = { paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm', 'white'] }) };
// Custom editors typed from the element's parameters, the IDs the editor owns, and the document parameters.
function Good({ values, set, Control, document }: ElementEditorProps<typeof route, 'zoom' | 'size', typeof doc>) {
  const z: number = values.zoom;
  const paper: 'warm' | 'white' = document.paper;
  set({ zoom: z + 1, size: 'large' });
  // @ts-expect-error
  set({ zoon: 2 });
  // @ts-expect-error
  set({ zoom: 'x' });
  // @ts-expect-error
  set({ size: 'huge' });
  // @ts-expect-error
  set({ note: 'x' });
  // @ts-expect-error
  const a = <Control parameter="note" />;
  // @ts-expect-error
  const b = <Control parameter="zoon" />;
  return <div>{paper}{a}{b}<Control parameter="zoom" /></div>;
}
// Typed for a parameter the element's editor does not list.
function Wrong({ Control }: ElementEditorProps<typeof route, 'note'>) { return <Control parameter="note" />; }
// Untyped props stay compatible with every declaration.
function Broad({ values, set, Control }: ElementEditorProps) { set({ anything: 1 }); return <Control parameter={String(values.x)} />; }
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: ({ spread }) => ({
  a: spread({ label: 'A', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom', 'size'], component: Good } } }, render: () => <Spread /> }),
  b: spread({ label: 'B', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom', 'size'], component: Broad } } }, render: () => <Spread /> }),
  // @ts-expect-error
  c: spread({ label: 'C', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'], component: Wrong } } }, render: () => <Spread /> }),
  // An inline editor can be annotated too; it is then checked against the declaration like a separate one.
  d: spread({ label: 'D', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'],
    component: ({ values, set }: ElementEditorProps<typeof route, 'zoom'>) => {
      // @ts-expect-error
      set({ size: 'large' });
      set({ zoom: values.zoom + 1 });
      return null;
    } } } }, render: () => <Spread /> }),
}) });

// A plain-object spread passes the template's document parameters to its editors too, so an editor typed with them
// compiles there as it does in the builder.
function PaperEditor({ document }: ElementEditorProps<typeof route, 'zoom', typeof doc>) {
  const paper: 'warm' | 'white' = document.paper;
  return paper;
}
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: {
  a: { label: 'A', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'], component: PaperEditor } } }, render: () => <Spread /> },
} });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: ({ spread }) => ({
  a: spread({ label: 'A', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'], component: PaperEditor } } }, render: () => <Spread /> }),
}) });
// ...and an editor that reads a document parameter the template does not declare fails in both forms.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: {
  a: { label: 'A', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'], component: PaperEditor } } }, render: () => <Spread /> },
} });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  // @ts-expect-error
  a: spread({ label: 'A', elements: { e: { label: 'E', parameters: route, editor: { parameters: ['zoom'], component: PaperEditor } } }, render: () => <Spread /> }),
}) });

// Layout families: a layout may only join a family the template declares, through the builder or a plain object.
const GridPicker = ({ variants, current, choose, find }: LayoutPickerProps) =>
  <div>{variants.map(({ id, label }) => <button key={id} aria-pressed={id === current} onClick={() => choose(find({ size: label }) ?? id)}>{label}</button>)}</div>;
defineTemplate({ id: 't', version: '1', contract: 1, format, requires: ['layout-families'],
  layoutFamilies: { grid: { label: 'Photo grid', picker: { label: 'Grid size', component: GridPicker } } },
  spreads: ({ spread }) => ({
    four: spread({ label: '2×2', family: 'grid', variant: { size: '2x2' }, render: () => <Spread /> }),
    nine: spread({ label: '3×3', family: 'grid', variant: { size: '3x3' }, render: () => <Spread /> }),
  }) });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, layoutFamilies: { grid: { label: 'Photo grid' } },
  spreads: ({ spread }) => ({
    four: spread({ label: '2×2', family: 'grid', render: () => <Spread /> }),
    nine: spread({ label: '3×3', family: 'grids', render: () => <Spread /> }),
  }) });
defineTemplate({ id: 't', version: '1', contract: 1, format, layoutFamilies: { grid: { label: 'Photo grid' } }, spreads: {
  four: { label: '2×2', family: 'grid', render: () => <Spread /> },
  nine: { label: '3×3', family: 'grid', render: () => <Spread /> },
} });
defineTemplate({ id: 't', version: '1', contract: 1, format, layoutFamilies: { grid: { label: 'Photo grid' } }, spreads: {
  // TypeScript reports the record at its first entry.
  // @ts-expect-error
  four: { label: '2×2', family: 'grid', render: () => <Spread /> },
  nine: { label: '3×3', family: 'grids', render: () => <Spread /> },
} });
// Without layoutFamilies, no family can be named.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  four: spread({ label: '2×2', family: 'grid', render: () => <Spread /> }),
}) });
// A picker is a component of LayoutPickerProps, and tags are strings, numbers or booleans.
defineTemplate({ id: 't', version: '1', contract: 1, format,
  // @ts-expect-error
  layoutFamilies: { grid: { label: 'Photo grid', picker: { component: (props: { values: string[] }) => props.values.length } } },
  spreads: { four: { label: '2×2', family: 'grid', render: () => <Spread /> } } });
defineTemplate({ id: 't', version: '1', contract: 1, format, layoutFamilies: { grid: { label: 'Photo grid' } }, spreads: ({ spread }) => ({
  // @ts-expect-error
  four: spread({ label: '2×2', family: 'grid', variant: { size: [2, 2] }, render: () => <Spread /> }),
}) });

// An element editor may also edit layout (spread) parameters it lists in `spread`; only declared ones are allowed.
const stamp = { show: p.boolean({ label: 'Show', default: true }) };
const caption = { caption: p.string({ label: 'Caption', default: '' }) };
const StampEditor = ({ Control }: import('imageflow').ElementEditorProps) =>
  <div><Control parameter="show" /><Control parameter="caption" scope="spread" /></div>;
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  a: spread({ label: 'A', parameters: caption, render: () => <Spread />,
    elements: { stamp: { label: 'Stamp', parameters: stamp, editor: { parameters: ['show'], spread: ['caption'], component: StampEditor } } } }),
  b: spread({ label: 'B', parameters: caption, render: () => <Spread />,
    // @ts-expect-error
    elements: { stamp: { label: 'Stamp', parameters: stamp, editor: { parameters: ['show'], spread: ['captoin'], component: StampEditor } } } }),
}) });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: {
  a: { label: 'A', parameters: caption, render: () => <Spread />,
    elements: { stamp: { label: 'Stamp', parameters: stamp, editor: { parameters: ['show'], spread: ['caption'], component: StampEditor } } } },
} });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: {
  a: { label: 'A', parameters: caption, render: () => <Spread />,
    elements: { stamp: { label: 'Stamp', parameters: stamp, editor: { parameters: ['show'], spread: ['captoin'], component: StampEditor } } } },
} });

// Typed scoped editors keep each schema and ownership list separate, even for a shared parameter ID.
const scopedLayout = { zoom: p.string({ label: 'Zoom label', default: '' }), title: p.string({ label: 'Title', default: '' }) };
function Scoped({ values, spread, set, setSpread, Control }: ElementEditorProps<typeof route, 'zoom', typeof doc, typeof scopedLayout, 'zoom'>) {
  set({ zoom: values.zoom + 1 });
  setSpread({ zoom: spread.zoom.toUpperCase() });
  const title: string = spread.title;
  // @ts-expect-error
  set({ zoom: 'x' });
  // @ts-expect-error
  setSpread({ zoom: 2 });
  // @ts-expect-error
  setSpread({ title: 'unowned' });
  // @ts-expect-error
  setSpread({ zoon: 'typo' });
  // @ts-expect-error
  const unowned = <Control parameter="title" scope="spread" />;
  // @ts-expect-error
  const wrongScope = <Control parameter="size" scope="spread" />;
  return <div>{title}{unowned}{wrongScope}<Control parameter="zoom" /><Control parameter="zoom" scope="spread" /></div>;
}
function SpreadOnly({ set, setSpread, Control }: ElementEditorProps<{}, never, typeof doc, typeof scopedLayout, 'zoom'>) {
  // @ts-expect-error
  set({ zoom: 1 });
  setSpread({ zoom: 'label' });
  // @ts-expect-error
  const wrongScope = <Control parameter="zoom" />;
  return <div>{wrongScope}<Control parameter="zoom" scope="spread" /></div>;
}
function NoSpread({ setSpread }: ElementEditorProps<typeof route, 'zoom', typeof doc, typeof scopedLayout, never>) {
  // @ts-expect-error
  setSpread({ zoom: 'unowned' });
  return null;
}
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: ({ spread }) => ({
  a: spread({ label: 'A', parameters: scopedLayout, elements: { e: { label: 'E', parameters: route,
    editor: { parameters: ['zoom'], spread: ['zoom'], component: Scoped } } }, render: () => <Spread /> }),
  b: spread({ label: 'B', parameters: scopedLayout, elements: { e: { label: 'E',
    editor: { parameters: [], spread: ['zoom'], component: SpreadOnly } } }, render: () => <Spread /> }),
  c: spread({ label: 'C', parameters: scopedLayout, elements: { e: { label: 'E', parameters: route,
    // @ts-expect-error
    editor: { parameters: ['zoom'], spread: ['title'], component: Scoped } } }, render: () => <Spread /> }),
  d: spread({ label: 'D', parameters: scopedLayout, elements: { e: { label: 'E', parameters: route,
    // @ts-expect-error
    editor: { parameters: ['zoom'], component: Scoped } } }, render: () => <Spread /> }),
}) });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: {
  a: { label: 'A', parameters: scopedLayout, elements: { e: { label: 'E', parameters: route,
    editor: { parameters: ['zoom'], spread: ['zoom'], component: Scoped } } }, render: () => <Spread /> },
} });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: doc, spreads: {
  a: { label: 'A', parameters: scopedLayout, elements: { e: { label: 'E', parameters: route,
    editor: { parameters: ['zoom'], spread: ['title'], component: Scoped } } }, render: () => <Spread /> },
} });
// Opening spreads name declared layouts and set parameters with plain values, with spreads as a function or a record.
defineTemplate({ id: 't', version: '1', contract: 1, format, requires: ['opening-spreads'],
  spreads: ({ spread }) => ({ a: spread({ label: 'A', parameters: foo, render: () => <Spread /> }) }),
  openingSpreads: [{ layout: 'a', params: { foo: 'x' } }, { layout: 'a' }] });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, spreads: { a: imported },
  openingSpreads: [{ layout: 'a' }] });
// A layout that is not declared is reported, in either form.
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({ a: spread({ label: 'A', render: () => <Spread /> }) }),
  openingSpreads: [{ layout: 'b' }] });
// @ts-expect-error
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, spreads: { a: imported }, openingSpreads: [{ layout: 'b' }] });
// Parameter values are strings, numbers or booleans.
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: foo, spreads: { a: imported },
  // @ts-expect-error
  openingSpreads: [{ layout: 'a', params: { foo: ['x'] } }] });

// Document editors are typed from the document parameters and the IDs they own, and read the spread's context.
const calendarDocument = { marked: p.string({ label: 'Marked', default: '' }), first: p.date({ label: 'First', default: '2027-01-01' }) };
function Days({ values, set, context, Control }: DocumentEditorProps<typeof calendarDocument, 'marked'>) {
  // `values` holds only the editor's own parameters; other settings come from the context.
  // @ts-expect-error
  values.first;
  const first: string = context.document.first + values.marked;
  const page: number | undefined = context.page.number;
  const month: string = context.document.first;
  const anchors = context.book.anchors('month');
  set({ marked: first + month + anchors.length + page });
  // @ts-expect-error
  set({ first: '2027-02-01' });
  // @ts-expect-error
  set({ marked: 3 });
  // @ts-expect-error
  const a = <Control parameter="first" />;
  return <div>{a}<Control parameter="marked" />{context.spread}{context.layout}</div>;
}
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: calendarDocument,
  editors: { days: { label: 'Days', parameters: ['marked'], component: Days } },
  spreads: ({ spread }) => ({ a: spread({ label: 'A', render: (ctx) => <Spread><ol {...ctx.edit('document.marked')} /></Spread> }) }) });
// Element editors read the same context.
function WithContext({ context }: ElementEditorProps<typeof route, 'zoom'>) { return <div>{context.page.left}{context.formatId}</div>; }

// Enum maps infer saved values from their keys, with the same checks as array options.
const languageMap = p.enum({ label: 'Language', options: { en: 'English', de: 'Deutsch' }, default: 'en' });
const languageValue: 'en' | 'de' = languageMap.default;
// @ts-expect-error unknown default
p.enum({ label: 'Language', options: { en: 'English' }, default: 'fr' });
// @ts-expect-error labels belong in the map
p.enum({ label: 'Language', options: { en: 'English' }, default: 'en', labels: { en: 'English' } });

// Number-like object keys normalize to string saved values, whether or not the keys are quoted.
const numericEnum = p.enum({ label: 'Year', options: { 2024: 'This year', 10: 'Ten', older: 'Older' }, default: '2024' });
const numericEnumValue: '2024' | '10' | 'older' = numericEnum.default;
// @ts-expect-error defaults remain string saved values
p.enum({ label: 'Year', options: { 2024: 'This year' }, default: 2024 });
// @ts-expect-error missing numeric key
p.enum({ label: 'Year', options: { 2024: 'This year' }, default: '2025' });

// #102: editors shown on the page. `presentation` is typed, and editors read where they are shown.
function OnPage({ presentation, values }: ElementEditorProps<typeof route, 'zoom'>) {
  const where: 'inline' | 'dialog' = presentation;
  return <div>{where}{values.zoom}</div>;
}
function DaysOnPage({ presentation }: DocumentEditorProps<typeof calendarDocument, 'marked'>) { return <div>{presentation === 'inline' ? 'page' : 'panel'}</div>; }
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: calendarDocument,
  editors: { days: { parameters: ['marked'], component: DaysOnPage, presentation: 'inline' } },
  spreads: ({ spread }) => ({ a: spread({ label: 'A', elements: { e: { label: 'E', parameters: route,
    editor: { parameters: ['zoom'], component: OnPage, presentation: 'inline' } } }, render: () => <Spread /> }) }) });
defineTemplate({ id: 't', version: '1', contract: 1, format, parameters: calendarDocument,
  // @ts-expect-error only the panel and the page
  editors: { days: { parameters: ['marked'], component: DaysOnPage, presentation: 'sidebar' } },
  spreads: ({ spread }) => ({ a: spread({ label: 'A', render: () => <Spread /> }) }) });

// Inline plain text is additive; only string paths and the supported presentation are accepted.
defineTemplate({ id: 'inline-text', version: '1', contract: 1, format,
  spreads: ({ spread }) => ({ title: spread({ label: 'Title', parameters: { heading: p.string({ label: 'Heading', default: '' }), count: p.integer({ label: 'Count', default: 1 }) },
    render: (ctx) => <Spread>
      <ctx.Text parameter="heading" presentation="inline" />
      {/* @ts-expect-error string parameters only */}
      <ctx.Text parameter="count" presentation="inline" />
      <ctx.Text parameter="heading" presentation="dialog" />
      {/* @ts-expect-error 'inline' or 'dialog', as for editors */}
      <ctx.Text parameter="heading" presentation="popover" />
    </Spread> }) }) });

// List parameters (#115): `render` reads an array of items with their `id` and every field typed.
const tracks = p.list({ label: 'Tracks', max: 12, item: {
  track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
  colour: p.color({ label: 'Colour', default: '#c0392b' }),
  width: p.number({ label: 'Width', default: 1 }),
}, default: [{ colour: '#000000' }] });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  map: spread({
    label: 'Map',
    elements: { map: { label: 'Map', parameters: { tracks }, controls: ['tracks'] } },
    render: (ctx) => <Spread>{ctx.elements.map.params.tracks.map((item) => <i key={item.id}>{item.track.length + item.width}{item.colour}</i>)}</Spread>,
  }),
}) });
defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({
  map: spread({
    label: 'Map',
    elements: { map: { label: 'Map', parameters: { tracks } } },
    // @ts-expect-error
    render: (ctx) => <Spread>{ctx.elements.map.params.tracks[0].label}</Spread>,
  }),
}) });
// Item fields are checked like parameters, and default items only name declared fields.
// @ts-expect-error
p.list({ label: 'L', item: { name: p.string({ label: 'Name', default: '', mutliline: true }) } });
// @ts-expect-error
p.list({ label: 'L', item: { name: p.string({ label: 'Name', default: '' }) }, default: [{ title: 'x' }] });
// An editor can show one field of one item.
function TrackEditor({ values, Control }: ElementEditorProps<{ tracks: typeof tracks }, 'tracks'>) {
  return <>{values.tracks.map((item) => <Control key={item.id} parameter="tracks" item={item.id} field="track" />)}</>;
}
void TrackEditor;
// A template's own preview image is a path to a file in the template folder.
defineTemplate({ id: 'preview', version: '1', contract: 1, format, preview: './preview.jpg',
  spreads: ({ spread }) => ({ a: spread({ label: 'A', render: () => <Spread /> }) }) });
// @ts-expect-error a path, not an imported image or a list
defineTemplate({ id: 'preview', version: '1', contract: 1, format, preview: ['./preview.jpg'],
  spreads: ({ spread }) => ({ a: spread({ label: 'A', render: () => <Spread /> }) }) });
