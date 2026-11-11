// A photo grid inside the safe area and a full-bleed panorama with a caption.
import { box, defineTemplate, geometry, mm, p, pt, Spread, spreadFor } from 'imageflow';

const format = {
  label: 'Example · 20 × 20 cm',
  trim: { width: mm(200), height: mm(200) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(12), bottom: mm(12), outside: mm(12), binding: mm(15) },
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow', minimumTextSize: pt(7) },
} as const;
const spread = spreadFor({});
const ids = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

export default defineTemplate({
  id: 'example-grid-bleed', version: '1.0.0', contract: 1, requires: ['geometry', 'box-helpers', 'typed-components'],
  format,
  spreads: {
    grid: spread({
      label: 'Six photos',
      parameters: { gap: p.number({ label: 'Gap', default: 4, min: 0, max: 12, step: .5, unit: 'mm' }) },
      boxes: Object.fromEntries(ids.map((id, i) => [id, box.photo('Photo ' + (i + 1))])) as Record<typeof ids[number], ReturnType<typeof box.photo>>,
      render: (ctx) => {
        // Three cells per page, each page inside its own safe area, so no photo crosses the fold.
        const cells = (['left', 'right'] as const).flatMap((side) =>
          geometry.grid(geometry.page(ctx.format, side, 'safe'), { columns: 1, rows: 3, gap: ctx.params.gap }));
        return <Spread>{ids.map((id, i) => <ctx.PhotoBox key={id} id={id} style={geometry.css(cells[i])} />)}</Spread>;
      },
    }),
    panorama: spread({
      label: 'Panorama',
      parameters: { caption: p.string({ label: 'Caption', default: '' }) },
      boxes: { one: box.photo('Panorama') },
      render: (ctx) => {
        const safe = geometry.spread(ctx.format, 'safe');
        return <Spread>
          <ctx.PhotoBox id="one" style={geometry.css(geometry.spread(ctx.format, 'bleed'))} />
          {(ctx.params.caption || ctx.mode === 'edit') && <p {...ctx.edit('caption')}
            style={{ ...geometry.css({ ...safe, y: safe.y + safe.height - 6, height: 6 }), margin: 0, color: '#fff', font: '8pt sans-serif' }}>
            {ctx.params.caption || 'Add a caption'}
          </p>}
        </Spread>;
      },
    }),
  },
});
