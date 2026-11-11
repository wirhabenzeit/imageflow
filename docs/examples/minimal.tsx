// Minimal template: one layout with a photo, an editable heading and page numbers.
import { defineTemplate, geometry, mm, p, pt, Spread, spreadFor } from 'imageflow';

const format = {
  label: 'Example · 20 × 20 cm',
  trim: { width: mm(200), height: mm(200) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(12), bottom: mm(12), outside: mm(12), binding: mm(15) },
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow', minimumTextSize: pt(7) },
} as const;
const spread = spreadFor({});

export default defineTemplate({
  id: 'example-minimal', version: '1.0.0', contract: 1, requires: ['geometry', 'typed-components'],
  format,
  spreads: {
    photo: spread({
      label: 'Photo and heading',
      parameters: { heading: p.string({ label: 'Heading', default: 'A day outside' }) },
      boxes: { hero: { type: 'photo', label: 'Photo' } },
      render: (ctx) => {
        // Rectangles are millimetres from the left page's trim corner; css() positions a node inside <Spread>.
        const text = geometry.page(ctx.format, 'right', 'safe');
        return <Spread>
          <ctx.PhotoBox id="hero" style={geometry.css(geometry.page(ctx.format, 'left', 'bleed'))} />
          <h1 {...ctx.edit('heading')} style={{ ...geometry.css({ ...text, height: 30 }), margin: 0, font: '600 24pt/1.2 serif' }}>
            {ctx.params.heading}
          </h1>
          <span style={{ ...geometry.css({ ...text, y: text.y + text.height - 6, height: 6 }), font: '8pt sans-serif', textAlign: 'right' }}>
            {ctx.page.right}
          </span>
        </Spread>;
      },
    }),
  },
});
