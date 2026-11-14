// Photo boxes drawn by render callbacks: SVG shapes that mask the photo, with each treatment's settings packaged with it.
import { box, defineTemplate, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { PhotoBoxState, PhotoRender } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

// A treatment is ordinary template code: the parameters it reads and a callback that draws the photo. The parameters
// join the box's own, so they appear in the photo toolbar next to Replace and Crop; `controls` shows only the chosen
// shape's settings. Box parameters share one namespace per box, so treatment parameters carry a prefix.
const frame = {
  parameters: {
    shape: p.enum({ label: 'Shape', default: 'arch', options: { none: 'None', arch: 'Arch', circle: 'Circle' } }),
    frameStroke: p.number({ label: 'Line', default: 1.5, min: 0, max: 6, step: .5, unit: 'mm' }),
    frameColor: p.color({ label: 'Line colour', default: '#f4efe6' }),
  },
  controls: ['shape', { group: 'Line', when: { shape: ['arch', 'circle'] }, controls: ['frameStroke', 'frameColor'] }] as const,
  // The callback works in the box's CSS pixels. It draws the whole photo at `photo.image`, which is where the host's
  // crop puts it, and clips it with the shape; the box clips everything to its own rectangle. Typed against the
  // parameters it reads, so using it on a box without them fails type checking.
  render: (photo: PhotoRender, box: PhotoBoxState<string, { shape: string; frameStroke: number; frameColor: string }>) => {
    const { width, height } = photo.box;
    const { shape, frameStroke, frameColor } = box.params;
    const line = frameStroke * 96 / 25.4;
    const r = width / 2;
    const outline = shape === 'circle'
      ? `M ${r} ${height / 2 - Math.min(r, height / 2)} a ${Math.min(r, height / 2)} ${Math.min(r, height / 2)} 0 1 0 0.01 0 Z`
      : `M 0 ${height} V ${r} A ${r} ${r} 0 0 1 ${width} ${r} V ${height} Z`;
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={photo.alt}>
      {shape !== 'none' && <defs><clipPath id={box.uid}><path d={outline} /></clipPath></defs>}
      <image href={photo.src} x={photo.image.x} y={photo.image.y} width={photo.image.width} height={photo.image.height}
        preserveAspectRatio="none" clipPath={shape !== 'none' ? `url(#${box.uid})` : undefined} />
      {shape !== 'none' && line > 0 && <path d={outline} fill="none" stroke={frameColor} strokeWidth={line} transform={`translate(${line / 2} ${line / 2}) scale(${(width - line) / width} ${(height - line) / height})`} />}
    </svg>;
  },
};

export default defineTemplate({
  id: 'example-photo-frames', version: '1.0.0', contract: 1,
  format,
  spreads: ({ spread }) => ({
    pair: spread({
      label: 'Two framed photos',
      boxes: {
        left: box.photo('Left photo', frame.parameters, { controls: frame.controls }),
        right: box.photo('Right photo', frame.parameters, { controls: frame.controls }),
      },
      render: (ctx) => {
        const left = ctx.geometry.inset(ctx.geometry.page('left', 'safe'), { top: 20, bottom: 20 });
        const right = ctx.geometry.inset(ctx.geometry.page('right', 'safe'), { top: 20, bottom: 20 });
        return <Spread style={{ background: '#2f3e46' }}>
          <ctx.PhotoBox id="left" rect={left}>{frame.render}</ctx.PhotoBox>
          {/* The one-line PhotoBox still works and uses the same crop; the callback is optional. */}
          <ctx.PhotoBox id="right" rect={right}>{(photo, box) => box.params.shape === 'none'
            ? <img src={photo.src} alt={photo.alt} style={photo.style} />
            : frame.render(photo, box)}</ctx.PhotoBox>
        </Spread>;
      },
    }),
  }),
});
