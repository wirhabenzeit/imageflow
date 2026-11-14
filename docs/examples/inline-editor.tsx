// An editor on the page (`presentation: 'inline'`): a focus ring over a full-bleed photo, dragged into place where it is printed.
import { defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { ElementEditorProps } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

const focus = {
  x: p.number({ label: 'Across', default: 50, min: 0, max: 100, unit: '%' }),
  y: p.number({ label: 'Down', default: 50, min: 0, max: 100, unit: '%' }),
  size: p.number({ label: 'Size', default: 30, min: 5, max: 80, unit: '%' }),
  colour: p.color({ label: 'Ring colour', default: '#ffffff' }),
};
type Focus = { x: number; y: number; size: number; colour: string };

// The ring as the page draws it. The editor draws the same ring, so it shows exactly what will print.
const Ring = ({ values }: { values: Focus }) => <div style={{ position: 'absolute', left: values.x + '%', top: values.y + '%',
  width: values.size + '%', aspectRatio: '1', transform: 'translate(-50%, -50%)', borderRadius: '50%', border: '1.5mm solid ' + values.colour }} />;

// ImageFlow places this component in the element's own frame, at its printed size, and hides the page's ring while it
// is open. The editor owns `x` and `y`; `size` and `colour` are generated controls in the toolbar under the canvas.
// Dragging calls `set` as it goes: each change is saved, validated and undoable. Pointer events stay in the frame,
// so nothing under the element is selected meanwhile.
function FocusEditor({ values, set, readOnly }: ElementEditorProps<typeof focus, 'x' | 'y'>) {
  const move = (event: { currentTarget: { getBoundingClientRect(): DOMRect }; clientX: number; clientY: number; buttons: number }) => {
    if (readOnly || !event.buttons) return;
    const area = event.currentTarget.getBoundingClientRect();
    const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
    set({ x: clamp((event.clientX - area.left) / area.width * 100), y: clamp((event.clientY - area.top) / area.height * 100) });
  };
  return <div style={{ position: 'absolute', inset: 0, cursor: readOnly ? 'default' : 'crosshair' }} onPointerDown={move} onPointerMove={move}>
    <Ring values={values} />
  </div>;
}

export default defineTemplate({
  id: 'example-inline-editor', version: '1.0.0', contract: 1,
  format,
  spreads: ({ spread }) => ({
    focus: spread({
      label: 'Photo with focus ring',
      boxes: { photo: { type: 'photo', label: 'Photo' } },
      elements: { focus: { label: 'Focus ring', parameters: focus,
        editor: { label: 'Place the ring', parameters: ['x', 'y'], component: FocusEditor, presentation: 'inline' } } },
      render: (ctx) => <Spread>
        <ctx.PhotoBox id="photo" rect={ctx.geometry.spread('bleed')} />
        <ctx.Element id="focus" rect={ctx.geometry.page('right', 'safe')}><Ring values={ctx.elements.focus.params} /></ctx.Element>
      </Spread>,
    }),
  }),
});
