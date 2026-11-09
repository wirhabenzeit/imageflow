"""Sets exact page boxes on a Chromium PDF of single book pages.

Chromium quantizes page sizes to 1/300 in, so the MediaBox can be off by up to ~0.33 pt.
This rewrites MediaBox/BleedBox to the requested size and adds a TrimBox that excludes
the bleed on top, bottom and the outside edge (right on odd pages, left on even pages).

Usage: .venv/bin/python postprocess.py in.pdf out.pdf WIDTH_MM HEIGHT_MM BLEED_MM
"""
import sys

import pikepdf

src, dst = sys.argv[1], sys.argv[2]
width, height, bleed = (float(v) / 25.4 * 72 for v in sys.argv[3:6])

pdf = pikepdf.open(src)
for index, page in enumerate(pdf.pages):
    right_page = index % 2 == 0  # page 1 is a right-hand page
    media = [0, 0, width, height]
    trim_x = 0 if right_page else bleed
    page.obj.MediaBox = pikepdf.Array(media)
    page.obj.CropBox = pikepdf.Array(media)
    page.obj.BleedBox = pikepdf.Array(media)
    page.obj.TrimBox = pikepdf.Array([trim_x, bleed, trim_x + width - bleed, height - bleed])
pdf.save(dst)
