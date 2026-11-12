// A layout family: a photo grid in 2×2 and 3×3, the 2×2 also with a text box, chosen with a picker of two independent controls.
import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { LayoutPickerProps, RenderContext } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

// Every variant is an ordinary layout with fixed boxes. Shared IDs carry content between them: the 2×2 boxes sit in
// the upper left of the 3×3 grid, and `story` is the same Markdown box in every variant that has one.
const sizes = {
  '2x2': { columns: 2, ids: ['a', 'b', 'c', 'd'] },
  '3x3': { columns: 3, ids: ['a', 'b', 'e', 'c', 'd', 'f', 'g', 'h', 'i'] },
} as const;
type Size = keyof typeof sizes;
const photos = <const S extends Size>(size: S) => box.photos(sizes[size].ids, (_id, i) => 'Photo ' + (i + 1));
const parameters = { gap: p.number({ label: 'Gap', default: 4, min: 0, max: 12, step: 1, unit: 'mm' }) };
// The grid's cells on the right page, in the variant's size.
const cells = (ctx: Pick<RenderContext, 'geometry'> & { params: { gap: number } }, size: Size) => {
  const { columns } = sizes[size];
  return ctx.geometry.grid(ctx.geometry.page('right', 'safe'), { columns, rows: columns, columnGap: ctx.params.gap, rowGap: ctx.params.gap });
};
const story = { font: '10pt/1.45 serif' };

// The picker shows two choices, size and text box, and maps them to a variant by its tags. There is no 3×3 grid with
// a text box: the picker says so and turns the text box off rather than offering a combination with no layout.
function GridPicker({ variants, current, choose, find, readOnly }: LayoutPickerProps) {
  const tags = variants.find(({ id }) => id === current)?.variant ?? {};
  const pick = (size: unknown, text: unknown) => {
    const id = find({ size: String(size), text: !!text }) ?? find({ size: String(size) });
    if (id) choose(id);
  };
  const textAvailable = !!find({ size: String(tags.size), text: true });
  const control = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--if-editor-border)', color: 'var(--if-editor-text)' };
  return <div style={{ display: 'grid', gap: 12, color: 'var(--if-editor-text)', font: '13px system-ui, sans-serif' }}>
    <div role="radiogroup" aria-label="Grid size" style={{ display: 'flex', gap: 8 }}>
      {Object.keys(sizes).map((size) => <button key={size} type="button" role="radio" aria-checked={tags.size === size} disabled={readOnly}
        onClick={() => pick(size, tags.text)}
        style={{ ...control, background: tags.size === size ? 'var(--if-editor-selection)' : 'var(--if-editor-control)' }}>
        {size.replace('x', ' × ')}</button>)}
    </div>
    <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: textAvailable ? undefined : 'var(--if-editor-muted)' }}>
      <input type="checkbox" checked={!!tags.text} disabled={readOnly || !textAvailable} onChange={() => pick(tags.size, !tags.text)} />
      Text box{textAvailable ? '' : ' (only with 2 × 2)'}
    </label>
  </div>;
}

export default defineTemplate({
  id: 'example-layout-family', version: '1.0.0', contract: 1,
  requires: ['spread-builder', 'bound-geometry', 'format-helper', 'typed-components', 'box-records', 'layout-families'],
  format,
  layoutFamilies: { grid: { label: 'Photo grid', picker: { label: 'Photo grid', component: GridPicker } } },
  spreads: ({ spread }) => ({
    grid4: spread({
      label: 'Grid 2×2', family: 'grid', variant: { size: '2x2', text: false },
      parameters, boxes: photos('2x2'),
      render: (ctx) => <Spread>{sizes['2x2'].ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells(ctx, '2x2')[i]} />)}</Spread>,
    }),
    grid4text: spread({
      label: 'Grid 2×2 with text', family: 'grid', variant: { size: '2x2', text: true },
      parameters, boxes: { ...photos('2x2'), story: box.markdown('Story') },
      render: (ctx) => <Spread>
        {sizes['2x2'].ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells(ctx, '2x2')[i]} />)}
        <ctx.MarkdownBox id="story" rect={ctx.geometry.page('left', 'safe')} style={story} />
      </Spread>,
    }),
    grid9: spread({
      label: 'Grid 3×3', family: 'grid', variant: { size: '3x3', text: false },
      parameters, boxes: photos('3x3'),
      render: (ctx) => <Spread>{sizes['3x3'].ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells(ctx, '3x3')[i]} />)}</Spread>,
    }),
  }),
});
