// A photo grid inside the safe area and a full-bleed panorama with a caption.
import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});
// Box IDs are saved identities: list them literally.
const ids = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

export default defineTemplate({
  id: 'example-grid-bleed', version: '1.0.0', contract: 1,
  format,
  spreads: ({ spread }) => ({
    grid: spread({
      label: 'Six photos',
      parameters: { gap: p.number({ label: 'Gap', default: 4, min: 0, max: 12, step: .5, unit: 'mm' }) },
      boxes: box.photos(ids, (id, i) => 'Photo ' + (i + 1)),
      render: (ctx) => {
        // Three cells per page, each page inside its own safe area, so no photo crosses the fold.
        const cells = (['left', 'right'] as const).flatMap((side) =>
          ctx.geometry.grid(ctx.geometry.page(side, 'safe'), { columns: 1, rows: 3, gap: ctx.params.gap }));
        return <Spread>{ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells[i]} />)}</Spread>;
      },
    }),
    panorama: spread({
      label: 'Panorama',
      parameters: { caption: p.string({ label: 'Caption', default: '', placeholder: 'Add a caption' }) },
      boxes: { one: box.photo('Panorama') },
      render: (ctx) => {
        const safe = ctx.geometry.spread('safe');
        // An empty caption shows its placeholder in the editor and nothing in the printed book.
        return <Spread>
          <ctx.PhotoBox id="one" rect={ctx.geometry.spread('bleed')} />
          <ctx.Text parameter="caption" rect={{ ...safe, y: safe.y + safe.height - 6, height: 6 }}
            style={{ margin: 0, color: '#fff', font: '8pt sans-serif' }} />
        </Spread>;
      },
    }),
  }),
});
