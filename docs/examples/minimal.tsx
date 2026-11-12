// Quickstart: one layout with a full-bleed photo, an editable heading, a book setting and a page number.
import { defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';

// Generic geometry for trying things out, not a printer's product: take page counts and output limits from the
// printer's specification before printing.
const format = printFormat({
  label: 'Example · 20 × 20 cm',
  trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) },
  safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers',
  pageCount: { min: 2, max: 200, step: 2 },
  output: { minimumTextSize: pt(7) },
});

// Preview only: the generic `serif` and `sans-serif` families render anywhere, but print export accepts only fonts
// bundled in template/fonts/ and loaded with @font-face from a CSS file the template imports (see the starter).
export default defineTemplate({
  id: 'example-minimal', version: '1.0.0', contract: 1,
  requires: ['spread-builder', 'bound-geometry', 'text-component', 'format-helper', 'typed-components'],
  format,
  // Book settings, declared once. `spread` below types `ctx.document` from them.
  parameters: { accent: p.color({ label: 'Heading colour', default: '#243b30' }) },
  spreads: ({ spread }) => ({
    photo: spread({
      label: 'Photo and heading',
      parameters: { heading: p.string({ label: 'Heading', default: 'A day outside' }) },
      boxes: { hero: { type: 'photo', label: 'Photo' } },
      render: (ctx) => {
        // Rectangles are millimetres from the left page's trim corner; `rect` positions a platform component.
        const text = ctx.geometry.page('right', 'safe');
        return <Spread>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          <ctx.Text parameter="heading" as="h1" rect={{ ...text, height: 30 }}
            style={{ margin: 0, font: '600 24pt/1.2 serif', color: ctx.document.accent }} />
          <span style={{ ...ctx.geometry.css({ ...text, y: text.y + text.height - 6, height: 6 }), font: '8pt sans-serif', textAlign: 'right' }}>
            {ctx.page.right}
          </span>
        </Spread>;
      },
    }),
  }),
});
