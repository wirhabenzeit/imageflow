// Format-responsive geometry: one layout that arranges photo and text by the shape of the chosen format.
import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';

const format = (label: string, width: number, height: number) => printFormat({
  label, trim: { width: mm(width), height: mm(height) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

export default defineTemplate({
  id: 'example-responsive', version: '1.0.0', contract: 1,
  requires: ['spread-builder', 'bound-geometry', 'text-component', 'format-helper', 'box-helpers', 'typed-components'],
  formats: { portrait: format('Portrait · 21 × 28 cm', 210, 280), landscape: format('Landscape · 28 × 21 cm', 280, 210) },
  defaultFormat: 'portrait',
  spreads: ({ spread }) => ({
    feature: spread({
      label: 'Photo and note',
      parameters: { note: p.string({ label: 'Note', default: 'A note about this photo.', multiline: true }) },
      boxes: { hero: box.photo('Photo') },
      render: (ctx) => {
        // Wide pages put the note beside the photo, tall pages below it. Only geometry changes; type stays 10 pt.
        const area = ctx.geometry.page('right', 'safe');
        const wide = area.width > area.height;
        const [photo, note] = wide
          ? ctx.geometry.grid(area, { columns: 2, gap: 8 })
          : [{ ...area, height: area.height * .7 }, ctx.geometry.inset(area, { top: area.height * .7 + 8 })];
        return <Spread>
          <ctx.PhotoBox id="hero" rect={photo} />
          <ctx.Text parameter="note" rect={note} style={{ margin: 0, font: '10pt/1.45 serif', whiteSpace: 'pre-line' }} />
        </Spread>;
      },
    }),
  }),
});
