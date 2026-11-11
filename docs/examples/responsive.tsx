// Format-responsive geometry: one layout that arranges photo and text by the shape of the chosen format.
import { box, defineTemplate, geometry, mm, p, pt, Spread, spreadFor } from 'imageflow';

const format = (label: string, width: number, height: number) => ({
  label,
  trim: { width: mm(width), height: mm(height) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(12), bottom: mm(12), outside: mm(12), binding: mm(15) },
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow', minimumTextSize: pt(7) },
} as const);
const spread = spreadFor({});

export default defineTemplate({
  id: 'example-responsive', version: '1.0.0', contract: 1, requires: ['geometry', 'box-helpers', 'typed-components'],
  formats: { portrait: format('Portrait · 21 × 28 cm', 210, 280), landscape: format('Landscape · 28 × 21 cm', 280, 210) },
  defaultFormat: 'portrait',
  spreads: {
    feature: spread({
      label: 'Photo and note',
      parameters: { note: p.string({ label: 'Note', default: 'A note about this photo.', multiline: true }) },
      boxes: { hero: box.photo('Photo') },
      render: (ctx) => {
        // Wide pages put the note beside the photo, tall pages below it. Only geometry changes; type stays 10 pt.
        const area = geometry.page(ctx.format, 'right', 'safe');
        const wide = area.width > area.height;
        const [photo, note] = wide
          ? geometry.grid(area, { columns: 2, gap: 8 })
          : [{ ...area, height: area.height * .7 }, geometry.inset(area, { top: area.height * .7 + 8 })];
        return <Spread>
          <ctx.PhotoBox id="hero" style={geometry.css(photo)} />
          <p {...ctx.edit('note')} style={{ ...geometry.css(note), margin: 0, font: '10pt/1.45 serif', whiteSpace: 'pre-line' }}>{ctx.params.note}</p>
        </Spread>;
      },
    }),
  },
});
