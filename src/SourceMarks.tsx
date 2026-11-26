import { Fragment } from 'react';
import { markText } from './source-properties';
import type { PhotoMark, SourceBadgeMark } from './source-properties';

const markClass = (mark: SourceBadgeMark) => 'source-mark source-mark-' + mark.kind +
  (mark.kind === 'flag' || mark.kind === 'color' ? ' source-mark-' + mark.kind + '-' + mark.value : '');

/**
 * A photo's marks from its provider's library (ADR 0014), each a glyph with its own accessible name and tooltip: filled
 * stars only, a heart, a pick flag or a reject cross, and a colour label as a dot, never as a tint of the photo. `tile`
 * draws them as one dark pill over a thumbnail; `inline` as text of a Manage Assets row or the Quick Look footer.
 */
export function SourceMarks({ marks, variant = 'inline' }: { marks: readonly PhotoMark[]; variant?: 'tile' | 'inline' }) {
  if (!marks.length) return null;
  return <span className={'source-marks source-marks-' + variant}>
    {marks.map(({ spec, mark }) => {
      // The tooltip names a custom colour label as well, so the accessible name does too.
      const { glyph, title } = markText(mark);
      return <span key={spec.id} className={markClass(mark)} role="img" aria-label={title} title={title}>
        {mark.kind === 'color' ? <span className="source-mark-dot" /> : glyph}</span>;
    })}
  </span>;
}

/** Whether the thumbnail of a photo with these marks is dimmed: it is rejected, and its flags are shown. */
export const rejectedMark = (marks: readonly PhotoMark[]) => marks.some(({ mark }) => mark.kind === 'flag' && mark.value === 'reject');

/**
 * The marks as rows of the Inspector's facts list (`<dl className="si-facts">`), one per property that is set, under
 * its spec's `inspectorLabel`: the rating with its empty stars, Picked or Rejected, the colour and a custom label's
 * name, and a favourite.
 */
export function MarkFacts({ marks }: { marks: readonly PhotoMark[] }) {
  return marks.map(({ spec, mark }) => {
    const { value, valueLabel } = markText(mark);
    return <Fragment key={spec.id}>
      <dt>{spec.inspectorLabel}</dt>
      <dd className={markClass(mark)}>
        {mark.kind === 'stars' ? <span role="img" aria-label={valueLabel} title={valueLabel}>{value}</span>
          : mark.kind === 'color' ? <><span className="source-mark-dot" aria-hidden="true" />{value}</>
          : mark.kind === 'heart' ? <><span className="source-mark-heart-glyph" aria-hidden="true">♥</span>{value}</>
          : value}
      </dd>
    </Fragment>;
  });
}
