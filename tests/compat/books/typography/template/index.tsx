import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';
import './styles.css';

// A typography workbench: layouts built around one kind of title each, plus a photo and a text frame so it works as
// a photobook. It exists to try the text API on real pages (inline editing fallbacks, formatted text, fitting,
// missing glyphs, effects in print), not to be a finished book design. Fonts are the Latin subsets of Source Serif 4 and Inter, so typing a character
// outside them, such as "Ł" or "Я", shows what happens when a font lacks a glyph.
const format = printFormat({
  label: 'Typography · 20 × 20 cm',
  trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) },
  safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers',
  pageCount: { min: 2, max: 40, step: 2 },
  output: { minimumTextSize: pt(7) },
});

const paper = '#f6f2ea';
const ink = '#1d1b18';

export default defineTemplate({
  id: 'imageflow-typography',
  version: '0.1.0',
  label: 'Typography',
  description: 'A photobook built around title typography: two-tone, cropped, stacked, fitted and effect type, with photo and story pages.',
  contract: 1,
  format,
  parameters: { accent: p.color({ label: 'Accent colour', default: '#b4472b' }) },
  spreads: ({ spread }) => ({
    story: spread({
      label: 'Photo and story',
      parameters: {
        eyebrow: p.string({ label: 'Label', default: 'Along the coast', maxLength: 40 }),
        title: p.string({ label: 'Title', default: 'Where the **road** meets the sea', multiline: true, maxLength: 60, markdown: 'inline' }),
      },
      boxes: { hero: box.photo('Photo'), body: box.markdown('Story', { flowOrder: 1 }) },
      render: (ctx) => {
        const text = ctx.geometry.page('right', 'safe');
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          <ctx.Text parameter="eyebrow" as="p" className="type-label" rect={{ ...text, height: 8 }} />
          <ctx.Text parameter="title" presentation="inline" as="h1" className="type-title story-title"
            rect={{ ...text, y: text.y + 14, height: 52 }} />
          <ctx.MarkdownBox id="body" className="type-body" rect={{ ...text, y: text.y + 76, height: text.height - 76 }} />
        </Spread>;
      },
    }),

    plate: spread({
      label: 'Photo plate',
      parameters: { title: p.string({ label: 'Title', default: 'Low *light*', maxLength: 40, markdown: 'inline' }) },
      boxes: { hero: box.photo('Photo') },
      render: (ctx) => {
        const area = ctx.geometry.spread('safe');
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          <ctx.PhotoBox id="hero" rect={{ ...area, height: area.height - 28 }} />
          <ctx.Text parameter="title" presentation="inline" as="h2" className="type-title plate-title"
            rect={{ ...area, y: area.y + area.height - 20, height: 20 }} />
        </Spread>;
      },
    }),

    twotone: spread({
      label: 'Two-tone title',
      parameters: {
        eyebrow: p.string({ label: 'Label', default: 'Typography', maxLength: 40 }),
        title: p.string({
          label: 'Title', default: 'Quiet **light**\nover *still* water', multiline: true, maxLength: 60, markdown: 'inline',
          description: 'Bold text takes the accent colour and italic text turns light, set in the template CSS.',
        }),
      },
      render: (ctx) => {
        const page = ctx.geometry.page('left', 'safe');
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          <ctx.Text parameter="eyebrow" as="p" className="type-label" rect={{ ...page, height: 8 }} />
          <ctx.Text parameter="title" presentation="inline" as="h1" className="type-title twotone"
            rect={{ ...page, y: page.y + 50, height: 100 }} />
        </Spread>;
      },
    }),

    cropped: spread({
      label: 'Cropped display title',
      parameters: { word: p.string({ label: 'Word', default: 'Photobook', maxLength: 14 }) },
      render: (ctx) => <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
        {/* Starts before the left trim and runs past the right bleed: the page edges cut it. */}
        <ctx.Text parameter="word" presentation="inline" as="h1" className="type-title cropped"
          rect={{ x: -30, y: 55, width: 460, height: 90 }} />
      </Spread>,
    }),

    vertical: spread({
      label: 'Stacked and turned',
      parameters: {
        stack: p.string({ label: 'Stacked word', default: 'Portfolio', maxLength: 14 }),
        caption: p.string({ label: 'Turned label', default: 'Field notes, volume one', maxLength: 40 }),
      },
      render: (ctx) => {
        const left = ctx.geometry.page('left', 'safe');
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          {/* Both opt into inline editing on purpose: the stacked word is vertical, the turned label is rotated.
              The safe-area check measures the font's em box, wider than the 12 mm line, so the word sits 3 mm in. */}
          <ctx.Text parameter="stack" presentation="inline" as="h1" className="type-title stacked"
            rect={{ x: left.x + 3, y: left.y, width: 30, height: left.height }} style={{ color: ctx.document.accent }} />
          {/* A 120 × 8 mm box centred at x = 300, y = 100, then turned a quarter. */}
          <ctx.Text parameter="caption" presentation="inline" as="p" className="type-label turned"
            rect={{ x: 240, y: 96, width: 120, height: 8 }} />
        </Spread>;
      },
    }),

    fit: spread({
      label: 'Title sized to fit',
      parameters: { title: p.string({ label: 'Title', default: 'Every word fits', maxLength: 28 }) },
      render: (ctx) => {
        const area = ctx.geometry.page('right', 'safe');
        // Pure and approximate: an uppercase heavy serif is about 0.72 em per letter. A title that still does not
        // fit is reported by the Book check as text running out of its box.
        const size = Math.min(70, area.width / (0.72 * Math.max(ctx.params.title.length, 4)));
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          <ctx.Text parameter="title" presentation="inline" as="h1" className="type-title fitted"
            rect={{ ...area, y: 100 - size * 0.55, height: size * 1.1 }} style={{ fontSize: size + 'mm', lineHeight: 1.1 }} />
        </Spread>;
      },
    }),

    effects: spread({
      label: 'Type effects',
      parameters: {
        outline: p.string({ label: 'Outlined (shadows)', default: 'Outline', maxLength: 16 }),
        gradient: p.string({ label: 'Gradient fill', default: 'Gradient', maxLength: 16 }),
        shadow: p.string({ label: 'Shadow', default: 'Shadow', maxLength: 16 }),
      },
      render: (ctx) => {
        const area = ctx.geometry.spread('safe');
        const row = (index: number) => ({ ...area, y: area.y + 8 + index * 56, height: 46 });
        return <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent, '--paper': paper }}>
          <ctx.Text parameter="outline" presentation="inline" as="h2" className="type-title effect effect-outline" rect={row(0)} />
          <ctx.Text parameter="gradient" presentation="inline" as="h2" className="type-title effect effect-gradient" rect={row(1)} />
          <ctx.Text parameter="shadow" presentation="inline" as="h2" className="type-title effect effect-shadow" rect={row(2)} />
        </Spread>;
      },
    }),

    stroke: spread({
      label: 'Stroked type (fails print export)',
      parameters: { word: p.string({ label: 'Stroked word', default: 'Stroke', maxLength: 16 }) },
      render: (ctx) => <Spread style={{ background: paper, color: ink, '--accent': ctx.document.accent }}>
        <ctx.Text parameter="word" presentation="inline" as="h2" className="type-title effect effect-stroke"
          rect={{ ...ctx.geometry.spread('safe'), y: 70, height: 60 }} />
      </Spread>,
    }),
  }),
  // The stroked layout is left out: a book that contains it cannot be exported for print.
  // Cropped display title is also left out: its type deliberately runs off the page, which the Book check reports.
  openingSpreads: [
    { layout: 'twotone' }, { layout: 'story' }, { layout: 'plate' }, { layout: 'vertical' }, { layout: 'fit' }, { layout: 'effects' },
  ],
});
