#!/bin/sh
# Generates synthetic test images with known pixel sizes, ICC profiles and EXIF orientation.
set -eu
cd "$(dirname "$0")"
mkdir -p assets
P=/System/Library/ColorSync/Profiles

# 3600 x 3600 test chart: saturated patches, a gradient, and 1-px line pairs to reveal resampling.
magick -size 3600x3600 gradient:'#202020-#f0f0f0' \
  -fill '#ff0000' -draw 'rectangle 200,200 1000,1000' \
  -fill '#00ff00' -draw 'rectangle 1100,200 1900,1000' \
  -fill '#0000ff' -draw 'rectangle 2000,200 2800,1000' \
  -fill '#00ffff' -draw 'rectangle 200,1100 1000,1900' \
  -fill '#ff00ff' -draw 'rectangle 1100,1100 1900,1900' \
  -fill '#ffff00' -draw 'rectangle 2000,1100 2800,1900' \
  \( -size 1200x1200 pattern:vertical2 \) -geometry +2000+2100 -composite \
  \( -size 1200x1200 pattern:horizontal2 \) -geometry +200+2100 -composite \
  -strip assets/chart-raw.png

# sRGB-tagged JPEG (the baseline).
magick assets/chart-raw.png -profile "$P/sRGB Profile.icc" -quality 92 assets/chart-srgb.jpg

# Same pixel values tagged as Display P3 / Adobe RGB without conversion:
# if the ICC profile is honoured, these render visibly more saturated than the sRGB chart.
magick assets/chart-raw.png -quality 92 assets/tmp.jpg
magick assets/tmp.jpg -set profile "$P/Display P3.icc" assets/chart-p3.jpg
magick assets/tmp.jpg -set profile "$P/AdobeRGB1998.icc" assets/chart-adobergb.jpg
# Untagged JPEG.
cp assets/tmp.jpg assets/chart-untagged.jpg
rm assets/tmp.jpg

# EXIF orientation 6: pixels stored rotated, tag says "rotate 90° clockwise to display".
magick assets/chart-srgb.jpg -rotate -90 assets/rot.jpg
python3 set-orientation.py assets/rot.jpg assets/chart-orient6.jpg 6 && rm assets/rot.jpg

# Very high resolution (7200 px) to check whether Chromium downsamples.
magick assets/chart-raw.png -resize 7200x7200 -profile "$P/sRGB Profile.icc" -quality 92 assets/chart-7200.jpg

# Low resolution (900 px) to check that nothing is upsampled.
magick assets/chart-raw.png -resize 900x900 -profile "$P/sRGB Profile.icc" -quality 92 assets/chart-900.jpg

# PNG with an alpha channel.
magick -size 1200x1200 xc:none -fill 'rgba(200,30,30,0.6)' -draw 'circle 600,600 600,100' assets/alpha.png

magick identify -format '%f %wx%h %[orientation] %[profile:icc]\n' assets/*.jpg

# Photo-like 4000 x 3000 image (fractal noise) to measure file size when images are re-encoded.
magick -size 4000x3000 -seed 7 plasma:fractal -blur 0x1 -profile "$P/sRGB Profile.icc" -quality 90 assets/photo.jpg
