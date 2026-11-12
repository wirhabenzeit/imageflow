// Generated content with parameters: a trip summary drawn from element parameters, edited by clicking it.
import { defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

function Stats({ distance, days, unit }: { distance: number; days: number; unit: 'km' | 'mi' }) {
  const shown = unit === 'mi' ? distance / 1.609 : distance;
  return <svg viewBox="0 0 100 40" style={{ width: '100%', height: '100%' }}>
    <rect x="0" y="28" width={Math.min(100, shown / 10)} height="4" fill="#243b30" />
    <text x="0" y="14" fontSize="10" fontFamily="serif">{Math.round(shown)} {unit} in {days} days</text>
  </svg>;
}

export default defineTemplate({
  id: 'example-generated-element', version: '1.0.0', contract: 1, requires: ['spread-builder', 'bound-geometry', 'format-helper', 'typed-components'],
  format,
  spreads: ({ spread }) => ({
    summary: spread({
      label: 'Trip summary',
      elements: { stats: {
        label: 'Trip summary',
        parameters: {
          distance: p.number({ label: 'Distance', default: 420, min: 0, max: 5000, step: 1, unit: 'km' }),
          days: p.integer({ label: 'Days', default: 6, min: 1, max: 365 }),
          unit: p.enum({ label: 'Units', default: 'km', options: ['km', 'mi'], labels: { km: 'Kilometres', mi: 'Miles' } }),
        },
      } },
      render: (ctx) => {
        const { distance, days, unit } = ctx.elements.stats.params;
        const area = ctx.geometry.page('right', 'safe');
        // <Element> is the click target for its own parameters; ctx.Element only accepts this layout's element IDs.
        return <Spread>
          <ctx.Element id="stats" rect={{ ...area, height: area.width * .4 }}>
            <Stats distance={distance} days={days} unit={unit} />
          </ctx.Element>
        </Spread>;
      },
    }),
  }),
});
