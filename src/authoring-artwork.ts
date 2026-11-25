/** A bounded grid whose cells fit differently shaped pages without stretching them. Labels occupy their own row.
 * `header` reserves a band of that many pixels above the grid, inside `maxEdge`. */
/** Pages and spreads are drawn at one scale, so a single page is half as wide as a spread and as high (API-012). */
export function contactSheetLayout(sizes: { widthMm: number; heightMm: number }[], maxEdge: number, requestedColumns: number, header = 0) {
  const columns = Math.min(requestedColumns, sizes.length), rows = Math.ceil(sizes.length / columns);
  const gap = Math.min(4, Math.floor(maxEdge / (Math.max(columns, rows) * 8)));
  const available = maxEdge - header;
  const rowHeight = Math.floor((available - gap * (rows - 1)) / rows);
  const labelHeight = Math.max(1, Math.min(16, Math.floor(rowHeight / 3)));
  const widest = Math.max(...sizes.map(({ widthMm }) => widthMm)), highest = Math.max(...sizes.map(({ heightMm }) => heightMm));
  const scale = Math.min(Math.floor((maxEdge - gap * (columns - 1)) / columns) / widest, (rowHeight - labelHeight) / highest);
  const cellWidth = Math.max(1, Math.floor(widest * scale));
  const imageHeight = Math.max(1, Math.min(rowHeight - labelHeight, Math.ceil(highest * scale)));
  const cellHeight = imageHeight + labelHeight;
  return { columns, width: columns * cellWidth + gap * (columns - 1), height: header + rows * cellHeight + gap * (rows - 1),
    cells: sizes.map(({ widthMm, heightMm }, index) => {
      const width = Math.max(1, Math.floor(widthMm * scale)), height = Math.max(1, Math.floor(heightMm * scale));
      const left = (index % columns) * (cellWidth + gap), top = header + Math.floor(index / columns) * (cellHeight + gap);
      return { x: left + Math.floor((cellWidth - width) / 2), y: top, width, height,
        label: { x: left, y: top + imageHeight, width: cellWidth, height: labelHeight } };
    }) };
}

/** Height of the banner that marks synthetic fixture artwork. */
export const fixtureBannerHeight = (maxEdge: number) => Math.max(14, Math.min(24, Math.round(maxEdge / 40)));

/**
 * A bounded grid of photos, uncropped, each row as high as its highest photo. Two lines of label are below each one.
 * Photos are fitted into square cells, so landscape and portrait ones are about as large.
 */
export function photoSheetLayout(sizes: ({ width: number; height: number } | undefined)[], maxEdge: number, requestedColumns: number) {
  const gap = 8, size = 11, line = 14, labelHeight = line * 2;
  // More columns than asked for when the rows, with their labels and photos at least 40 pixels high, would not fit.
  const rowsThatFit = Math.max(1, Math.floor((maxEdge - gap) / (labelHeight + gap + 40)));
  const columns = Math.min(Math.max(requestedColumns, Math.ceil(sizes.length / rowsThatFit)), sizes.length);
  const shapes = sizes.map((photo) => {
    const { width, height } = photo ?? { width: 3, height: 2 }, longest = Math.max(width, height);
    return { width: width / longest, height: height / longest };
  });
  const rows = Array.from({ length: Math.ceil(shapes.length / columns) }, (_, row) =>
    Math.max(...shapes.slice(row * columns, (row + 1) * columns).map(({ height }) => height)));
  const high = rows.reduce((sum, height) => sum + height, 0);
  // The columns use the width, unless the rows would then be higher than the sheet may be.
  const cell = Math.max(16, Math.floor(Math.min((maxEdge - gap * (columns + 1)) / columns, (maxEdge - gap * (rows.length + 1) - labelHeight * rows.length) / high)));
  const tops: number[] = [];
  let top = gap;
  for (const height of rows) {
    tops.push(top);
    top += Math.ceil(height * cell) + labelHeight + gap;
  }
  return { columns, width: columns * cell + gap * (columns + 1), height: top,
    cells: shapes.map((shape, index) => {
      const row = Math.floor(index / columns), left = gap + (index % columns) * (cell + gap);
      const width = Math.max(1, Math.round(shape.width * cell)), height = Math.max(1, Math.round(shape.height * cell));
      const floor = tops[row] + Math.ceil(rows[row] * cell);
      return { x: left + Math.floor((cell - width) / 2), y: floor - height, width, height,
        label: { x: left, y: floor, width: cell, line, size } };
    }) };
}
