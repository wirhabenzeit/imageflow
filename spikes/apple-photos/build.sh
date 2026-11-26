#!/bin/zsh
# Builds out/<variant>/Photos Spike.app: Electron with the addon, signed with hardened runtime.
#   ./build.sh entitled   usage description + com.apple.security.personal-information.photos-library
#   ./build.sh bare       usage description only
# ELECTRON: an Electron.app; IDENTITY: a codesigning identity ("-" for ad hoc).
set -e
here=${0:a:h}; variant=${1:-entitled}; out=$here/out/$variant; app="$out/Photos Spike.app"
: ${ELECTRON:=$here/../../node_modules/electron/dist/Electron.app} ${IDENTITY:=-}
include=${NODE_INCLUDE_DIR:-${$(readlink -f $(which node)):h:h}/include/node}
rm -rf $out; mkdir -p $out; cp -Rc $ELECTRON $app 2>/dev/null || cp -R $ELECTRON $app
res=$app/Contents/Resources; rm -f $res/default_app.asar; mkdir -p $res/app/native; cp $here/main.cjs $res/app/
echo '{"name":"photos-spike","main":"main.cjs"}' > $res/app/package.json
xcrun clang++ -std=c++17 -fobjc-arc -shared -undefined dynamic_lookup -arch arm64 -mmacosx-version-min=13.0 -DNAPI_VERSION=8 -Wno-unguarded-availability-new \
  -framework AppKit -framework CoreImage -framework ImageIO -framework Photos -framework PhotosUI -framework UniformTypeIdentifiers -I $include $here/native/photos.mm -o $res/app/native/photos.node
p=$app/Contents/Info.plist
plutil -replace CFBundleIdentifier -string ch.wirhabenzeit.imageflow.photos-spike-$variant $p
plutil -replace CFBundleName -string "Photos Spike" $p; plutil -replace CFBundleDisplayName -string "ImageFlow Photos Spike ($variant)" $p
plutil -insert NSPhotoLibraryUsageDescription -string "Read-only measurements for ImageFlow issue 327: how fast Photos hands over facts and pictures. Nothing is changed or uploaded." $p
jit='<key>com.apple.security.cs.allow-jit</key><true/>'
ph='<key>com.apple.security.personal-information.photos-library</key><true/>'
[[ $variant == bare ]] && ph=''
for f in main helper; do echo "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>$jit$([[ $f == main ]] && echo $ph)</dict></plist>" > $out/$f.plist; done
fw=$app/Contents/Frameworks
find $fw $res/app -type f \( -name '*.dylib' -o -name '*.node' \) -print0 | xargs -0 -n1 codesign -f -s $IDENTITY --options runtime --timestamp=none
for h in $fw/*.app; do codesign -f -s $IDENTITY --options runtime --timestamp=none --entitlements $out/helper.plist "$h"; done
find "$fw/Electron Framework.framework/Versions/A/Helpers" $fw/Squirrel.framework/Versions/A/Resources -type f -perm +111 -print0 | xargs -0 -n1 codesign -f -s $IDENTITY --options runtime --timestamp=none
for h in $fw/*.framework; do codesign -f -s $IDENTITY --options runtime --timestamp=none "$h"; done
codesign -f -s $IDENTITY --options runtime --timestamp=none --entitlements $out/main.plist "$app"
codesign --verify --deep --strict "$app" && echo "$app"
