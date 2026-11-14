// Editing UI at three levels: generated controls, arranged controls with a condition, and a custom editor that reuses ImageFlow's controls.
import { defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { ElementEditorProps } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

const patterns = ['dots', 'stripes', 'grid'] as const;
const backdropParameters = {
  pattern: p.enum({ label: 'Pattern', default: 'dots', options: patterns }),
  tint: p.color({ label: 'Tint', default: '#c9d6cf' }),
  opacity: p.number({ label: 'Opacity', default: .6, min: .1, max: 1, step: .05 }),
};
// Level 3: a picker the generated controls cannot draw, plus ImageFlow's own colour control for `tint`. The dialog
// saves both with Done; the element's other parameters appear below this editor as generated controls. The props
// are typed from the declaration, so `set({ pattern: 'waves' })` or `<Control parameter="opacity" />` fails type
// checking: `waves` is not an option, and `opacity` is not one of this editor's parameters.
function PatternEditor({ values, set, readOnly, Control }: ElementEditorProps<typeof backdropParameters, 'pattern' | 'tint'>) {
  return <div>
    <div role="radiogroup" aria-label="Pattern" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      {patterns.map((pattern) => <button key={pattern} type="button" role="radio" aria-checked={values.pattern === pattern}
        disabled={readOnly} onClick={() => set({ pattern })}
        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--if-editor-border)', color: 'var(--if-editor-text)',
          background: values.pattern === pattern ? 'var(--if-editor-selection)' : 'var(--if-editor-control)' }}>{pattern}</button>)}
    </div>
    <Control parameter="tint" />
  </div>;
}

export default defineTemplate({
  id: 'example-editing-levels', version: '1.0.0', contract: 1,
  format,
  parameters: {
    showFooter: p.boolean({ label: 'Show footer', default: true }),
    footer: p.string({ label: 'Footer', default: 'Our travels' }),
  },
  controls: ['showFooter', { group: 'Footer', when: { showFooter: true }, controls: ['footer'] }],
  spreads: ({ spread }) => ({
    marks: spread({
      label: 'Marks',
      elements: {
        // Level 1, the default: a control per parameter, generated. A request for "a changeable emoji" needs this
        // and nothing more: one input, and a size if wanted. Do not add source modes nobody asked for.
        emoji: { label: 'Emoji', parameters: {
          emoji: p.string({ label: 'Emoji', default: '🏔', maxLength: 8 }),
          size: p.number({ label: 'Size', default: 24, min: 8, max: 72, step: 1, unit: 'pt' }),
        } },
        // Level 2: the template arranges the generated controls. The group appears only while the stamp is shown;
        // hidden controls keep their values, and every parameter stays editable through project commands.
        stamp: {
          label: 'Stamp',
          parameters: {
            show: p.boolean({ label: 'Show stamp', default: true }),
            text: p.string({ label: 'Text', default: 'Visited', maxLength: 24 }),
            tilt: p.number({ label: 'Tilt', default: -8, min: -30, max: 30, step: 1, unit: '°' }),
            ink: p.color({ label: 'Ink', default: '#a33a2b' }),
          },
          controls: ['show', { group: 'Stamp', when: { show: true }, controls: [
            'text', { parameter: 'tilt', label: 'Rotation', description: 'Negative values turn it counter-clockwise.' }, 'ink',
          ] }],
        },
      },
      render: (ctx) => {
        const page = ctx.geometry.page('right', 'safe');
        const { emoji, stamp } = ctx.elements;
        return <Spread>
          {ctx.document.showFooter && <span {...ctx.edit('document.footer')}>{ctx.document.footer}</span>}
          <ctx.Element id="emoji" rect={{ ...page, width: 40, height: 30 }} style={{ fontSize: emoji.params.size + 'pt', lineHeight: 1 }}>
            {emoji.params.emoji}
          </ctx.Element>
          <ctx.Element id="stamp" rect={{ ...page, y: page.y + 40, width: 60, height: 20 }}>
            {stamp.params.show && <span style={{ display: 'inline-block', padding: '1mm 3mm', border: '0.6mm solid', color: stamp.params.ink,
              transform: 'rotate(' + stamp.params.tilt + 'deg)', font: '600 12pt sans-serif' }}>{stamp.params.text}</span>}
          </ctx.Element>
        </Spread>;
      },
    }),
    pattern: spread({
      label: 'Pattern page',
      elements: {
        // Level 3: a custom editor for `pattern` and `tint`. `opacity` has no custom UI, so it is a generated control
        // in the same dialog.
        backdrop: {
          label: 'Backdrop',
          parameters: backdropParameters,
          editor: { label: 'Edit backdrop', parameters: ['pattern', 'tint'], component: PatternEditor },
        },
      },
      render: (ctx) => {
        const { pattern, tint, opacity } = ctx.elements.backdrop.params;
        const image = pattern === 'dots' ? 'radial-gradient(' + tint + ' 20%, transparent 22%)'
          : pattern === 'stripes' ? 'repeating-linear-gradient(45deg, ' + tint + ' 0 2mm, transparent 2mm 5mm)'
          : 'linear-gradient(' + tint + ' 0.4mm, transparent 0.4mm), linear-gradient(90deg, ' + tint + ' 0.4mm, transparent 0.4mm)';
        return <Spread>
          {ctx.document.showFooter && <span {...ctx.edit('document.footer')}>{ctx.document.footer}</span>}
          <ctx.Element id="backdrop" rect={ctx.geometry.spread('bleed')} style={{ backgroundImage: image, backgroundSize: '6mm 6mm', opacity }} />
        </Spread>;
      },
    }),
  }),
});
