// An optional file input: a CSV of daily distances drawn as a chart, with a structured finding for bad files.
import { defineTemplate, file, issue, mm, p, printFormat, pt, Spread } from 'imageflow';

const format = printFormat({
  label: 'Example · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(12), binding: mm(15) },
  ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 }, output: { minimumTextSize: pt(7) },
});

// Rows of "day,km". Returns the values, or the first line that cannot be read.
function parseDistances(text: string): { values: number[] } | { line: number } {
  const values: number[] = [];
  const lines = text.trim().split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const km = Number(line.split(',')[1]);
    if (!Number.isFinite(km) || km < 0) return { line: i + 1 };
    values.push(km);
  }
  return { values };
}

export default defineTemplate({
  id: 'example-file-input', version: '1.0.0', contract: 1,
  format,
  spreads: ({ spread }) => ({
    chart: spread({
      label: 'Distance chart',
      elements: { chart: { label: 'Chart', parameters: { data: p.file({ label: 'Distances (CSV)', accept: ['.csv'] }) } } },
      render: (ctx) => {
        const id = ctx.elements.chart.params.data;
        const source = file(id);
        const parsed = source ? parseDistances(source.text) : undefined;
        const area = ctx.geometry.page('right', 'safe');
        const rect = { ...area, height: area.height / 2 };
        // No file assigned is valid: nothing in print, a hint in the editor.
        if (!parsed) return <Spread>{ctx.mode === 'edit' && <ctx.Element id="chart" rect={rect}>Add a CSV of daily distances</ctx.Element>}</Spread>;
        if ('line' in parsed) {
          // Reported on the element, its file parameter and the file, with the line as a detail. A hidden node works in export.
          return <Spread><ctx.Element id="chart" rect={rect}>
            <span hidden {...issue({ code: 'csv-invalid', message: source!.name + ' line ' + parsed.line + ' is not "day,km".',
              element: 'chart', parameter: 'data', file: id, details: { line: parsed.line },
              suggestion: 'Fix the line in the CSV file, or assign another file.' })} />
          </ctx.Element></Spread>;
        }
        const max = Math.max(1, ...parsed.values);
        return <Spread><ctx.Element id="chart" rect={rect}>
          <svg viewBox={'0 0 ' + parsed.values.length * 10 + ' 100'} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
            {parsed.values.map((km, i) => <rect key={i} x={i * 10 + 1} y={100 - km / max * 100} width="8" height={km / max * 100} fill="#243b30" />)}
          </svg>
        </ctx.Element></Spread>;
      },
    }),
  }),
});
