import { defineTemplate, p, mm, Spread, PhotoBox, MarkdownBox } from 'imageflow';
import './styles.css';

const safe = mm(5);

export default defineTemplate({
  id: 'whitewall-field-notes',
  version: '0.1.0',
  contract: 1,
  format: {
    label: 'WhiteWall Gallery Square · 29 × 29 cm',
    trim: { width: mm(290), height: mm(290) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
    safe: { top: safe, bottom: safe, outside: safe, binding: safe },
    structure: {
      delivery: 'pages',
      ends: 'single-pages',
      pageCount: { min: 28, max: 112, step: 4 },
    },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
  },
  parameters: { showCaption: p.boolean({ label: 'Show caption', default: true }) },
  spreads: {
    story: {
      label: 'Photo and story',
      parameters: {
        heading: p.string({ label: 'Heading', default: '' }),
        eyebrow: p.string({ label: 'Chapter label', default: '' }),
      },
      boxes: {
        landscape: { type: 'photo', label: 'Landscape' },
        story: { type: 'markdown', label: 'Story', flowOrder: 1 },
      },
      render: ({ params, document, boxes }) => (
        <Spread className="field-notes">
          <PhotoBox id="landscape" className="left-page" />
          <div className="right-page paper" />
          <p className="kicker">{params.eyebrow}</p>
          <h1>{params.heading}</h1>
          <div className="rule" />
          <MarkdownBox id="story" className="story" />
          {document.showCaption && boxes.landscape.photo?.caption && (
            <p className="caption">{boxes.landscape.photo.caption}</p>
          )}
        </Spread>
      ),
    },
  },
});
