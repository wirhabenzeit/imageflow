// Photo and story with text continuation, chapter anchors and a contents layout.
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
const heading = p.string({ label: 'Heading', default: 'Chapter' });
const reading = { font: '10pt/1.45 serif' };
// The same box ID in two layouts is the same box: switching layouts keeps its text.
const story = box.markdown('Story', { flowOrder: 1 });

export default defineTemplate({
  id: 'example-photo-story', version: '1.0.0', contract: 1, requires: ['anchors', 'geometry', 'box-helpers', 'typed-components'],
  format,
  spreads: {
    story: spread({
      label: 'Photo and story',
      parameters: { heading },
      boxes: { hero: box.photo('Photo'), story },
      anchors: ({ params }) => [{ id: 'chapter', title: params.heading, side: 'right' }],
      render: (ctx) => {
        const text = geometry.page(ctx.format, 'right', 'safe');
        return <Spread>
          <ctx.PhotoBox id="hero" style={geometry.css(geometry.page(ctx.format, 'left', 'bleed'))} />
          <h2 {...ctx.edit('heading')} style={{ ...geometry.css({ ...text, height: 20 }), margin: 0, font: '600 20pt/1.2 serif' }}>
            {ctx.params.heading}
          </h2>
          <ctx.MarkdownBox id="story" style={{ ...geometry.css(geometry.inset(text, { top: 28 })), ...reading }} />
        </Spread>;
      },
    }),
    // Text that does not fit continues here, in flowOrder: the left box, then the right box.
    continued: spread({
      label: 'Story continued',
      boxes: { story, more: box.markdown('Right text', { flowOrder: 2 }) },
      render: (ctx) => <Spread>
        {(ctx.boxes.story.text?.part ?? 1) > 1 &&
          <p style={{ ...geometry.css({ ...geometry.page(ctx.format, 'left', 'safe'), height: 6 }), margin: 0, font: 'italic 8pt serif' }}>continued</p>}
        <ctx.MarkdownBox id="story" style={{ ...geometry.css(geometry.inset(geometry.page(ctx.format, 'left', 'safe'), { top: 10 })), ...reading }} />
        <ctx.MarkdownBox id="more" style={{ ...geometry.css(geometry.inset(geometry.page(ctx.format, 'right', 'safe'), { top: 10 })), ...reading }} />
      </Spread>,
    }),
    // Anchors are known before any spread renders, so the pages are right after inserts, moves and layout switches.
    contents: spread({
      label: 'Contents',
      render: (ctx) => <Spread>
        <ol style={{ ...geometry.css(geometry.page(ctx.format, 'right', 'safe')), margin: 0, padding: 0, listStyle: 'none', font: '11pt/1.8 serif' }}>
          {ctx.book.anchors('chapter').map((chapter) => <li key={chapter.spread} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{chapter.title}</span><span>{chapter.page}</span>
          </li>)}
        </ol>
      </Spread>,
    }),
  },
});
