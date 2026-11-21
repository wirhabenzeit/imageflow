import { box, defineTemplate, mm, printFormat, Spread } from 'imageflow';
import './styles.css';

// Fixture for smoke-spread-text: one Markdown box over both pages of a spread (`rects`), with and without
// `alignHeads`. A composition turns "## 12 June · Over the pass" into a head that spans the box's columns.
const format = printFormat({
  label: 'Spread · 2 × A3',
  trim: { width: mm(297), height: mm(420) },
  bleed: { all: mm(3), binding: mm(0) },
  safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers',
  pageCount: { min: 2, max: 40, step: 2 },
});

export default defineTemplate({
  id: 'spread-text',
  version: '0.1.0',
  label: 'Spread text',
  contract: 1,
  format,
  parameters: {},
  compositions: {
    // Date and title as two spanning elements, whose margins collapse where they meet.
    stacked: ({ blocks }) => <>
      {blocks.flatMap((block) => block.type === 'heading' && block.depth === 2
        ? [<p key={block.key + 'd'} className="day-line" data-keep-next>{block.text.split(' · ')[0]}</p>,
           <h3 key={block.key + 't'} className="day-title" data-keep-next>{block.text.split(' · ')[1] ?? block.content}</h3>]
        : [block.node])}
    </>,
    story: ({ blocks }) => <>
      {blocks.map((block) => block.type === 'heading' && block.depth === 2
        ? <div key={block.key} className="day-head" data-keep-next>
            <span className="day">{block.text.split(' · ')[0]}</span>
            <h3>{block.text.split(' · ')[1] ?? block.content}</h3>
          </div>
        : block.node)}
    </>,
  },
  spreads: ({ spread }) => ({
    // One box over both pages in full, heads wherever the text puts them.
    run: spread({
      label: 'Running text',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'story' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} rects={[ctx.geometry.page('left', 'safe'), ctx.geometry.page('right', 'safe')]} />
      </Spread>,
    }),
    // A band across the bottom of both pages: the head that opens it leaves the same room on both.
    band: spread({
      label: 'Opener band',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'story' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} alignHeads rects={[band(ctx, 'left'), band(ctx, 'right')]} />
      </Spread>,
    }),
    // The band with a head made of two spanning elements.
    bandStacked: spread({
      label: 'Opener band, stacked head',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'stacked' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} alignHeads rects={[band(ctx, 'left'), band(ctx, 'right')]} />
      </Spread>,
    }),
    // The same band without alignHeads, for comparison.
    bandPlain: spread({
      label: 'Band, not aligned',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'story' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} rects={[band(ctx, 'left'), band(ctx, 'right')]} />
      </Spread>,
    }),
    // A right rectangle shorter than the head's room: nothing fits below it.
    short: spread({
      label: 'Short right rectangle',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'story' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} alignHeads
          rects={[band(ctx, 'left'), { ...band(ctx, 'right'), height: 12 }]} />
      </Spread>,
    }),
    // One rectangle only, as before.
    single: spread({
      label: 'Single box',
      boxes: { body: box.markdown('Story', { flowOrder: 1, composition: 'story' }) },
      render: (ctx) => <Spread>
        <ctx.MarkdownBox id="body" className="body" columns={2} rect={ctx.geometry.page('right', 'safe')} />
      </Spread>,
    }),
  }),
});

function band(ctx: { geometry: { page(side: 'left' | 'right', area?: 'safe'): { x: number; y: number; width: number; height: number } } }, side: 'left' | 'right') {
  const page = ctx.geometry.page(side, 'safe');
  return { ...page, y: page.y + page.height - 110, height: 110 };
}
