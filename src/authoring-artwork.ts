/** A bounded grid whose cells fit differently shaped pages without stretching them. Labels occupy their own row.
 * `header` reserves a band of that many pixels above the grid, inside `maxEdge`. */
export function contactSheetLayout(sizes: { widthMm: number; heightMm: number }[], maxEdge: number, requestedColumns: number, header = 0) {
  const columns = Math.min(requestedColumns, sizes.length), rows = Math.ceil(sizes.length / columns);
  const gap = Math.min(4, Math.floor(maxEdge / (Math.max(columns, rows) * 8)));
  const available = maxEdge - header;
  const rowHeight = Math.floor((available - gap * (rows - 1)) / rows);
  const labelHeight = Math.max(1, Math.min(16, Math.floor(rowHeight / 3)));
  const aspect = Math.max(...sizes.map(({ widthMm, heightMm }) => heightMm / widthMm));
  const cellWidth = Math.max(1, Math.floor(Math.min((maxEdge - gap * (columns - 1)) / columns,
    ((available - gap * (rows - 1)) / rows - labelHeight) / aspect)));
  const imageHeight = Math.max(1, Math.min(rowHeight - labelHeight, Math.ceil(cellWidth * aspect)));
  const cellHeight = imageHeight + labelHeight;
  return { columns, width: columns * cellWidth + gap * (columns - 1), height: header + rows * cellHeight + gap * (rows - 1),
    cells: sizes.map(({ widthMm, heightMm }, index) => {
      const scale = Math.min(cellWidth / widthMm, imageHeight / heightMm);
      const width = Math.max(1, Math.floor(widthMm * scale)), height = Math.max(1, Math.floor(heightMm * scale));
      const left = (index % columns) * (cellWidth + gap), top = header + Math.floor(index / columns) * (cellHeight + gap);
      return { x: left + Math.floor((cellWidth - width) / 2), y: top, width, height,
        label: { x: left, y: top + imageHeight, width: cellWidth, height: labelHeight } };
    }) };
}

/** Height of the banner that marks synthetic fixture artwork. */
export const fixtureBannerHeight = (maxEdge: number) => Math.max(14, Math.min(24, Math.round(maxEdge / 40)));
