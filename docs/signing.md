# Mac signing and notarization

Use a Mac matching the target architecture (arm64 for v1). Xcode Command Line Tools provide `codesign`, `notarytool`, `stapler`, `ditto` and `hdiutil`. Poppler is required by the packaged PDF smoke checks.

## Build commands

- `npm run package:mac` produces a local app. Without `APPLE_SIGNING_IDENTITY`, it uses the existing ad-hoc signature. With a Developer ID Application identity, it signs with hardened runtime and verifies the app, Electron helpers, esbuild, sharp and libvips.
- `npm run package:mac:release` requires the signing identity and all three notarization variables below. It notarizes and staples the app, verifies Gatekeeper acceptance, creates and signs a DMG, notarizes and staples that DMG, then produces the update ZIP from the stapled app.
- `npm run test:packaged` builds a local app and runs the packaged checks, including the MCP bridge launched through ImageFlow's own executable in Node mode.
- `npm run test:packaged:existing` runs those checks against the app already in `out/`. Use this after a release build to avoid rebuilding the notarized app.

The outputs are:

```text
out/ImageFlow-darwin-arm64/ImageFlow.app
out/ImageFlow-<version>-mac-arm64.zip
out/ImageFlow-<version>-arm64.dmg
```

The ZIP keeps `ImageFlow.app` as its parent directory, as required by Squirrel.Mac. The DMG contains the app and an Applications shortcut. Release filenames from an earlier attempt are removed before a release rebuild, so a failure cannot leave stale artifacts under the current version's names.

The script accepts `--arch arm64` or `--arch x64` after `node scripts/package-mac.mjs`. Build on a matching Mac: the staged esbuild and sharp binaries come from the host's installed dependencies.

## Local credentials

Create a **Developer ID Application** certificate through the Apple Developer account or Xcode, and install it in the login keychain with its matching private key. `security find-identity -v -p codesigning` lists the usable identities. An Apple Development or Apple Distribution identity is not sufficient for direct distribution.

Create an App Store Connect **team API key** with notarization access. Keep its downloaded `.p8` file, Key ID and Issuer ID together. A release build reads:

| Environment variable | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` identity name |
| `APPLE_SIGNING_KEYCHAIN` | Optional path to a dedicated signing keychain |
| `APPLE_API_KEY` | Path to the downloaded `.p8` file |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Team API key's Issuer ID |

Set these in the environment before running `npm run package:mac:release`. Signing alone does not submit anything to Apple; the explicit release command performs notarization.

## GitHub Actions credentials

In Keychain Access, export only the Developer ID Application identity, including its private key, as a password-protected `.p12`. Store the following repository Actions secrets:

| Secret | Contents |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` identity |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity name |
| `APPLE_API_KEY_BASE64` | Base64-encoded `.p8` file |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

Use them in a trusted macOS release job after checkout, Node setup and `npm ci`. Ordinary PR checks do not need signing credentials. The following steps import the identity into a temporary keychain, give Apple's signing tools access to that key, and remove the credentials after the job:

```yaml
- name: Prepare signing credentials
  env:
    P12_BASE64: ${{ secrets.APPLE_CERTIFICATE_P12_BASE64 }}
    P12_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}
  run: |
    umask 077
    IMAGEFLOW_KEYCHAIN="$RUNNER_TEMP/imageflow-signing.keychain-db"
    IMAGEFLOW_KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
    printf '::add-mask::%s\n' "$IMAGEFLOW_KEYCHAIN_PASSWORD"
    printf '%s' "$P12_BASE64" | base64 --decode > "$RUNNER_TEMP/ImageFlow.p12"
    printf '%s' "$API_KEY_BASE64" | base64 --decode > "$RUNNER_TEMP/ImageFlow-AuthKey.p8"
    security create-keychain -p "$IMAGEFLOW_KEYCHAIN_PASSWORD" "$IMAGEFLOW_KEYCHAIN"
    security set-keychain-settings -lut 21600 "$IMAGEFLOW_KEYCHAIN"
    security unlock-keychain -p "$IMAGEFLOW_KEYCHAIN_PASSWORD" "$IMAGEFLOW_KEYCHAIN"
    security import "$RUNNER_TEMP/ImageFlow.p12" -k "$IMAGEFLOW_KEYCHAIN" -P "$P12_PASSWORD" -f pkcs12 -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$IMAGEFLOW_KEYCHAIN_PASSWORD" "$IMAGEFLOW_KEYCHAIN"
    printf 'APPLE_SIGNING_KEYCHAIN=%s\n' "$IMAGEFLOW_KEYCHAIN" >> "$GITHUB_ENV"
    printf 'APPLE_API_KEY=%s\n' "$RUNNER_TEMP/ImageFlow-AuthKey.p8" >> "$GITHUB_ENV"
- name: Build release artifacts
  env:
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
    APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
  run: npm run package:mac:release
- name: Check the signed app
  run: npm run test:packaged:existing
- name: Remove signing credentials
  if: always()
  run: |
    security delete-keychain "$RUNNER_TEMP/imageflow-signing.keychain-db" || true
    rm -f "$RUNNER_TEMP/ImageFlow.p12" "$RUNNER_TEMP/ImageFlow-AuthKey.p8"
```

## Verification

Release builds fail if signing, notarization, stapling or Gatekeeper assessment fails. To inspect a built app manually:

```sh
codesign --verify --deep --strict --verbose=2 out/ImageFlow-darwin-arm64/ImageFlow.app
codesign --display --verbose=4 out/ImageFlow-darwin-arm64/ImageFlow.app
spctl --assess --verbose=4 --type execute out/ImageFlow-darwin-arm64/ImageFlow.app
xcrun stapler validate out/ImageFlow-darwin-arm64/ImageFlow.app
xcrun stapler validate out/ImageFlow-<version>-arm64.dmg
```

Gatekeeper should report `accepted` and `source=Notarized Developer ID`. Main and helper apps use hardened runtime and the JIT entitlement. Unsigned executable memory, disabled library validation and debugger access are not granted. The RunAsNode fuse remains enabled because both the MCP bridge and template typechecking use ImageFlow's own executable; the packaged MCP smoke test exercises that path.

References: [Apple's Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/), [Apple's notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Electron notarization](https://github.com/electron/notarize).
