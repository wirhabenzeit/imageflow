# Spike: rerun format and flow checks inside Electron

`docs/v1-decisions.md` requires rerunning the PDF format spike (`spikes/pdf-format`) and the text-flow spike (`spikes/text-flow`) inside Electron before building on them, because the app exports with Electron's bundled Chromium rather than Google Chrome.

Run on 2026-11-09 with Electron 45.2.3, the version used in the Electron draft (wirhabenzeit/imageflow#4).

## Running

Both spikes must have been run with Chrome first (they generate the HTML test documents and the Chrome reference output).

```sh
npm install
SPIKE_TASK=pdf ./node_modules/.bin/electron main.cjs   # → out/pdf/*.pdf, out/saal-spread-*.jpg
cd ../text-flow && ENGINE=electron node run.mjs        # → ../text-flow/out-electron/
```

`main.cjs` exports every `../pdf-format/out/*.html` with `webContents.printToPDF` (`preferCSSPageSize`, `printBackground`, no margins) and captures the Saal spread at 300 dpi. With `SPIKE_TASK=flow` it opens one hidden window, which the text-flow harness drives through Playwright's Electron support; the scenario PDF is printed from that window's current state with `printToPDF`.

## Results

- **Same engine.** Electron 45.2.3 bundles Chromium 156.0.8078.80, the exact version of the Chrome used in both spikes. The PDF producer is `Skia/PDF m156` in both.
- **PDF format: identical.** All nine test documents give the same page sizes (including the 1/300-in quantization), page boxes, image encodings and passthrough, colour profiles, transparency structures, and font types as Chrome's `page.pdf`. Rasterized at 50 dpi, all 19 pages are pixel-identical.
- **Text flow: identical outcome.** All checks pass as in Chrome: 360 random chains with no lost text, clipping, numbering errors, orphans, or widows (two headings at the end of boxes too small for more, as before); preview and PDF line breaks identical in every scenario box; a 15,177-word book flows in about 20 ms. The flowed scenario PDFs from Chrome and Electron are pixel-identical. The measure strategy needed 146 split corrections instead of 142, with the same final layout.
- **Hyphenation** behaves as in Chrome on macOS (English and German hyphenated with `hyphens: auto`).
- **Raster delivery.** An offscreen window of exactly 7016 × 3543 device px with `setZoomFactor(300/96)` captures the Saal spread at exactly the required pixel size, sRGB-tagged, and visually identical to the PDF rasterized at 300 dpi (remaining pixel differences come from resampling the 1-px line test pattern and JPEG compression). This fixes the 2-px error of Chrome's `deviceScaleFactor` screenshot. `enableDeviceEmulation` with a device scale factor does not scale `capturePage` output (2246 × 1134 px).

## Notes

- In the sandboxed shell used for this spike, Electron could not start additional renderer processes (`bootstrap_look_up … Permission denied`), so `main.cjs` reuses one window for all PDF exports. This is a limitation of the test environment, not of Electron; the packaged app is unaffected.
- `loadFile` rejected for one document (`ERR_FAILED`) although the page rendered completely; the export code tolerates a rejected load and checks readiness itself (fonts and images). The real exporter should do the same rather than rely on the `loadFile` promise.

## Conclusion

Every finding from `spikes/pdf-format` and `spikes/text-flow` holds inside Electron 45.2.3 without change. Exporting with `printToPDF` and `capturePage` in the app is equivalent to the Chrome-based spikes, and preview and export share one engine.
