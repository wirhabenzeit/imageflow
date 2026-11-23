# Mac signing and notarization

Use a Mac matching the target architecture (arm64 for v1). Xcode Command Line Tools provide `codesign`, `notarytool`, `stapler`, `ditto` and `hdiutil`. Poppler is required by the packaged PDF smoke checks.

Staging compiles the small AppKit document-header module and the CloudKit bridge of the iCloud sync backend with Xcode Command Line Tools and the Node-API headers included in official Node.js distributions. For installations with separate headers, set `NODE_INCLUDE_DIR` to the directory containing `node_api.h`. The module is unpacked and signed with the app; no compiler or Node installation is needed to run the packaged app.

## Build commands

- `npm run package:mac` produces a local app. Without `APPLE_SIGNING_IDENTITY`, it uses the existing ad-hoc signature. With a Developer ID Application identity, it signs with hardened runtime and verifies the app, Electron helpers, esbuild, sharp and libvips.
- `npm run package:mac:release` requires the signing identity and either a saved notarytool profile or all three API key variables below. It checks that the packaged app version matches `package.json`, notarizes and staples the app, verifies Gatekeeper acceptance, creates and signs a DMG, notarizes and staples that DMG, checks the DMG with Gatekeeper, then produces the update ZIP from the stapled app.
- `npm run test:packaged` builds a local app and runs the packaged checks, including the MCP bridge launched through ImageFlow's own executable in Node mode.
- `npm run test:packaged:existing` runs those checks against the app already in `out/`. Use this after a release build to avoid rebuilding the notarized app.
- `npm run notarize:mac` checks the version of the signed app already in `out/`, notarizes it and creates the release artifacts. Release jobs can build, run `test:packaged:existing`, then notarize that exact tested app without rebuilding it.

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

A certificate copied from another Mac, such as from a `.p12` export, may show as "not trusted" and `security find-identity -v -p codesigning` lists no valid identity. A `.p12` carries the certificate and key but not the intermediate certificate that issued it, which is missing from this Mac's keychain. Install it from [apple.com/certificateauthority](https://www.apple.com/certificateauthority/): **Developer ID - G2** for a Developer ID Application certificate, or **Worldwide Developer Relations - G3** for Apple Development and Apple Distribution. Each certificate names its issuer in its *Authority Information Access* field. Passing the identity's SHA-1 hash from `security find-identity` as `codesign --sign` also works when the name has characters such as "ö" that `codesign` does not match.

For local releases with saved notarytool credentials, set `APPLE_NOTARY_PROFILE` to the profile name and `APPLE_SIGNING_IDENTITY` to the installed Developer ID Application identity.

For API key authentication, create an App Store Connect **team API key** with notarization access. Keep its downloaded `.p8` file, Key ID and Issuer ID together. A release build reads:

| Environment variable | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` identity name |
| `APPLE_SIGNING_KEYCHAIN` | Optional path to a dedicated signing keychain |
| `APPLE_PROVISIONING_PROFILE` | Optional path to the Developer ID provisioning profile; see [iCloud](#icloud) |
| `APPLE_API_KEY` | Path to the downloaded `.p8` file |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Team API key's Issuer ID |

Set these in the environment before running `npm run package:mac:release`. Signing alone does not submit anything to Apple; the explicit release command performs notarization.

## GitHub Actions credentials

In Keychain Access, export only the Developer ID Application identity, including its private key, as a password-protected `.p12`. Store the following **environment secrets** under **Settings → Environments → release**:

| Secret | Contents |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` identity |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity name |
| `APPLE_API_KEY_BASE64` | Base64-encoded `.p8` file |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Issuer ID |
| `APPLE_PROVISIONING_PROFILE_BASE64` | Base64-encoded Developer ID provisioning profile; see [iCloud](#icloud) |

Configure `release` to allow only **tags matching `v*`**, require approval from `wirhabenzeit`, and disable administrator bypass. Self-review is allowed so the sole maintainer can approve their own release tags; an explicit approval is still required. Remove all repository-level copies of these secrets. Adding `environment: release` to YAML does not configure those GitHub protection settings by itself.

The [release workflow](../.github/workflows/release.yml) checks that the tagged commit belongs to `origin/main` before the protected job is scheduled, then checks it again after approval. The reviewer should inspect the tagged commit and workflow before approving credential access.

Credential access is limited to individual steps:

1. `release-secrets.mjs` validates all six secrets before the build, decoding and parsing the API key in memory. An empty or invalid key fails here without writing it to disk.
2. The app is built with no Apple credential variables or signing keychain available.
3. `mac-credentials.mjs sign` imports the certificate into a temporary keychain, signs the existing app without rebuilding it, restores the original search list, and deletes the keychain. The intermediate `.p12` is removed immediately after import. This step never writes an API key file.
4. Packaged tests run after the signing credentials have been removed.
5. `mac-credentials.mjs notarize` creates a fresh temporary keychain for DMG signing and writes the API key only for this operation. Its cleanup restores and verifies the original search list and removes the keychain and key file, including when the operation fails.

The helper passes neither the encoded certificate/key secrets nor the certificate password to the signing/notarization child process. Cleanup failures fail the job while still attempting to remove every temporary credential file. The signing and notarization libraries remain trusted tools that necessarily use the signing identity; the release environment's human approval is the credential-access boundary.

## iCloud

The iCloud sync backend (#292) uses CloudKit, which needs entitlements that a Developer ID app may only claim with a **provisioning profile** embedded in its bundle. The App ID `ch.wirhabenzeit.imageflow` (team `DX96FWY9AX`) has iCloud with CloudKit and the container `iCloud.ch.wirhabenzeit.imageflow`, and Push Notifications; its **Developer ID** profile (Certificates, Identifiers & Profiles → Profiles, type *Developer ID*) covers both, in the Production environment.

- With `APPLE_PROVISIONING_PROFILE` and a Developer ID identity, signing embeds the profile, and the main app alone gets `resources/entitlements.icloud.mac.plist`: JIT, `application-identifier`, `team-identifier`, `icloud-container-identifiers`, `icloud-services: CloudKit`, `icloud-container-environment: Production` and `aps-environment: production`. The Electron helpers keep the JIT entitlement only; the CloudKit addon runs in the main process.
- Without a profile, nothing claims iCloud and no profile is embedded (`preEmbedProvisioningProfile` is off, so a stray `.provisionprofile` in the working directory is never picked up). Such builds, ad-hoc builds and `npm run dev` work as before and report iCloud as unavailable in Settings → Sync: the addon reads its own entitlements and never touches CloudKit without them, since CloudKit traps a process that lacks them.
- Upgrade-test fixtures have another bundle ID and are always signed without the profile.
- In the release workflow, `mac-credentials.mjs sign` writes `APPLE_PROVISIONING_PROFILE_BASE64` to a temporary file for the signing step only. A release without that secret is built without iCloud.

**A Developer ID app that claims iCloud without a matching embedded profile is killed at launch** ("Launchd job spawn failed"), and a Mac with the profile *installed* (double-clicked, System Settings → General → Device Management) hides that, because macOS then uses the installed copy. So whenever the main app claims iCloud, `verify-mac-signing.mjs` checks the profile inside the bundle before notarization: present, for this App ID and team, a Developer ID profile (every Mac), Production, covering the container and push, and not expired. Do not install the profile on the Macs that test releases.

The check also requires the profile to name the certificate the app is signed with: a renewed Developer ID certificate needs a new profile. A build signed with a profile must claim iCloud, and one that embeds a profile without claiming iCloud fails too, so a release never ships without iCloud by accident.

**RunAsNode and iCloud.** The RunAsNode fuse stays on (see Verification): the MCP bridge and template typechecking run ImageFlow's executable in Node mode. Such a process carries the app's entitlements, so with iCloud any local process that can run the executable that way can reach ImageFlow's data in the user's private CloudKit database, as it could already read the user's books on disk. `npm run test:cloudkit` relies on this. Turning the fuse off needs another way to run the bridge and the typechecker first.

**Updating from a build without iCloud** keeps the designated requirement (Developer ID, team, bundle ID), so automatic updates and the keychain key behind the encrypted sync credentials should keep working. This is not tested yet: run the signed upgrade test (`npm run test:upgrade:signed`) from a release without the profile to one with it before the first release that carries iCloud.

A new App ID–container link takes minutes to reach CloudKit; until then, saves fail with `permissionFailure` "Invalid bundle ID for container". The CloudKit schema (record type `Blob` with `data`, `asset`, `size`, `sha256`) must be deployed to Production in the CloudKit Console.

## Verification

Release builds fail if signing, notarization, stapling or Gatekeeper assessment fails. To inspect a built app manually:

```sh
codesign --verify --deep --strict --verbose=2 out/ImageFlow-darwin-arm64/ImageFlow.app
codesign --display --verbose=4 out/ImageFlow-darwin-arm64/ImageFlow.app
spctl --assess --verbose=4 --type execute out/ImageFlow-darwin-arm64/ImageFlow.app
xcrun stapler validate out/ImageFlow-darwin-arm64/ImageFlow.app
xcrun stapler validate out/ImageFlow-<version>-arm64.dmg
spctl --assess --verbose=4 --type open --context context:primary-signature out/ImageFlow-<version>-arm64.dmg
```

Gatekeeper should report `accepted` and `source=Notarized Developer ID`. Main and helper apps use hardened runtime and the JIT entitlement; with the profile, the main app also has the iCloud entitlements (`codesign --display --entitlements :- …/ImageFlow.app`, and `security cms -D -i …/ImageFlow.app/Contents/embedded.provisionprofile` for the profile). Unsigned executable memory, disabled library validation and debugger access are not granted. The RunAsNode fuse remains enabled because both the MCP bridge and template typechecking use ImageFlow's own executable; the packaged MCP smoke test exercises that path.

References: [Apple's Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/), [Apple's notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Electron notarization](https://github.com/electron/notarize), [GitHub's temporary signing keychain setup](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).
