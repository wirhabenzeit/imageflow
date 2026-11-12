// Compile-time checks of the authoring types, run by `npm run build` (`tsc -p tests/types`). Each
// `@ts-expect-error` is a declaration a template author must be told about; the build fails if it compiles.
import { box, defineTemplate, mm, p, printFormat, Spread, spreadFor } from 'imageflow';
import type { LayoutPickerProps } from 'imageflow';

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
