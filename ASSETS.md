# Brand assets, sample photographs and third-party files

The source code in this repository is released under the [MIT License](LICENSE). The files listed below are **not**
covered by it.

## ImageFlow name, logo and icons

Copyright © 2026 the ImageFlow authors. All rights reserved.

- `resources/brand/` (logo, wordmarks, icon sources and the Icon Composer icon)
- `resources/ImageFlow.icns`, `resources/ImageFlowBook.icns`, `resources/ImageFlowTemplate.icns`, `resources/Assets.car`
- `resources/dmg/` (disk image background and window layout)

You may show them unmodified to refer to ImageFlow, for example in an article or a review, and they ship inside official
ImageFlow builds. A fork or other redistributed build must use its own name and icons and must not suggest that it is
an official ImageFlow release.

## Sample photographs

Copyright © 2026 the ImageFlow authors. All rights reserved.

- `sample/shared/photos/`, any `sample/*/photos/`, and each starter's `template/preview.jpg`
- the copies in `tests/compat/books/*/photos/`, `tests/compat/books/*/template/preview.jpg` and `tests/fixtures/*/photos/`
- the screenshots in `docs/images/`

New books don't receive the sample photographs, and release builds of the app don't contain them. You may use them to
develop and test ImageFlow and its templates, including books made with the development-build **Sample book (dev)**
option. Other uses, such as publishing or selling the photographs on their own or in stock or image collections, need
permission.

## Third-party files

These keep their own licences, which are included next to them:

- Inter and Source Serif 4 fonts: SIL Open Font License 1.1 (`template/fonts/*-OFL.txt` in each starter)
- MapLibre GL JS: BSD-3-Clause (`template/vendor/LICENSES/` in the photobook starter)
- React and csstype type declarations: MIT (`template/.imageflow-sdk/*/LICENSE`)

Official builds also bundle Electron and Chromium, which ship their own licence files inside the app.
