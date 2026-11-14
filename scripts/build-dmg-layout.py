#!/usr/bin/env python3
"""Regenerates resources/dmg/DS_Store, the Finder window layout of the ImageFlow disk image.

Run on a Mac after changing the window size, icon positions or background:

    python3 -m pip install --user dmgbuild==1.6.7
    npm run build:icons            # resources/dmg/background.png and background@2x.png
    python3 scripts/build-dmg-layout.py

dmgbuild writes the .DS_Store without scripting Finder. The release copies the result into every disk image
(scripts/mac-dmg.mjs), so building a release needs neither Python nor Finder.
"""
import os, shutil, subprocess, sys, tempfile

import dmgbuild

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DMG = os.path.join(ROOT, 'resources', 'dmg')

# Keep in step with resources/brand/dmg-background.svg (660 × 420, icons centred at x 170 and 490, y 215).
SETTINGS = {
    'format': 'UDRW', 'filesystem': 'HFS+',
    'files': [], 'symlinks': {'Applications': '/Applications'},
    'background': None,  # set below
    'window_rect': ((200, 120), (660, 420)),
    'default_view': 'icon-view', 'show_status_bar': False, 'show_tab_view': False, 'show_toolbar': False,
    'show_pathbar': False, 'show_sidebar': False, 'show_icon_preview': False,
    'arrange_by': None, 'icon_size': 128, 'text_size': 13, 'label_pos': 'bottom',
    'icon_locations': {'ImageFlow.app': (170, 215), 'Applications': (490, 215)},
}


def main():
    work = tempfile.mkdtemp(prefix='imageflow-dmg-')
    try:
        # Only the name matters for the layout; the release puts the real app in its place.
        app = os.path.join(work, 'ImageFlow.app')
        os.makedirs(os.path.join(app, 'Contents'))
        # dmgbuild joins background.png and background@2x.png into /.background.tiff on the volume.
        background = os.path.join(DMG, 'background.png')
        image = os.path.join(work, 'layout.dmg')
        settings = dict(SETTINGS, files=[app], background=background)
        dmgbuild.build_dmg(image, 'ImageFlow', settings=settings)
        mount = os.path.join(work, 'mount')
        os.mkdir(mount)
        subprocess.run(['hdiutil', 'attach', image, '-nobrowse', '-noautoopen', '-mountpoint', mount], check=True,
                       stdout=subprocess.DEVNULL)
        try:
            shutil.copyfile(os.path.join(mount, '.DS_Store'), os.path.join(DMG, 'DS_Store'))
        finally:
            subprocess.run(['hdiutil', 'detach', mount, '-quiet'], check=True)
        print('resources/dmg/DS_Store')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
