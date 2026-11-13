// Photo and story with text continuation, chapter anchors and a contents layout.
import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});
const heading = p.string({ label: 'Heading', default: 'Chapter' });
const reading = { font: '10pt/1.45 serif' };
// The same box ID in two layouts is the same box: switching layouts keeps its text.
const story = box.markdown('Story', { flowOrder: 1 });

export default defineTemplate({
  id: 'example-photo-story', version: '1.0.0', contract: 1,
  format,
  spreads: ({ spread }) => ({
    story: spread({
      label: 'Photo and story',
      parameters: { heading },
      boxes: { hero: box.photo('Photo'), story },
      anchors: ({ params }) => [{ id: 'chapter', title: params.heading, side: 'right' }],
      render: (ctx) => {
        const text = ctx.geometry.page('right', 'safe');
        return <Spread>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          <ctx.Text parameter="heading" as="h2" rect={{ ...text, height: 20 }} style={{ margin: 0, font: '600 20pt/1.2 serif' }} />
          <ctx.MarkdownBox id="story" rect={ctx.geometry.inset(text, { top: 28 })} style={reading} />
        </Spread>;
      },
    }),
    // Text that does not fit continues here, in flowOrder: the left box, then the right box.
    continued: spread({
      label: 'Story continued',
      boxes: { story, more: box.markdown('Right text', { flowOrder: 2 }) },
      render: (ctx) => <Spread>
        {(ctx.boxes.story.text?.part ?? 1) > 1 &&
          <p style={{ ...ctx.geometry.css({ ...ctx.geometry.page('left', 'safe'), height: 6 }), margin: 0, font: 'italic 8pt serif' }}>continued</p>}
        <ctx.MarkdownBox id="story" rect={ctx.geometry.inset(ctx.geometry.page('left', 'safe'), { top: 10 })} style={reading} />
        <ctx.MarkdownBox id="more" rect={ctx.geometry.inset(ctx.geometry.page('right', 'safe'), { top: 10 })} style={reading} />
      </Spread>,
    }),
    // Anchors are known before any spread renders, so the pages are right after inserts, moves and layout switches.
    contents: spread({
      label: 'Contents',
      render: (ctx) => <Spread>
        <ol style={{ ...ctx.geometry.css(ctx.geometry.page('right', 'safe')), margin: 0, padding: 0, listStyle: 'none', font: '11pt/1.8 serif' }}>
          {ctx.book.anchors('chapter').map((chapter) => <li key={chapter.spread} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{chapter.title}</span><span>{chapter.page}</span>
          </li>)}
        </ol>
      </Spread>,
    }),
  }),
});
