# Releasing ImageFlow for Mac

The **Release** workflow builds Apple silicon downloads when a `v*.*.*` tag is pushed. It checks the tag against `package.json` and verifies that the tagged commit belongs to `origin/main`, then builds and tests the Developer ID signed app, notarizes and staples the app and DMG, then stages the ZIP and DMG in a draft with generated notes and automatically publishes beta and stable releases. Approving the protected **release** environment is the only release approval. The workflow explicitly starts **Pages** on `main` to refresh and verify the update feeds. Rehearsal and other experimental prerelease tags remain drafts. Ordinary PR checks stay separate.

The six signing secrets in [Mac signing and notarization](signing.md) must be configured in the protected **release** environment first, with no repository-level copies. It accepts only `v*` tags, requires approval by `wirhabenzeit`, and disables administrator bypass. Before the first public release, make this repository public so release downloads and channel feeds are accessible without credentials.

## Prepare and tag

1. On a release-preparation branch, choose the version and update both package files:

   ```sh
   npm version 1.0.0 --no-git-tag-version
   ```

   Then record the built-in templates this version ships, so books made from them stay trusted for their network sites after a later update changes them:

   ```sh
   node scripts/released-templates.mjs
   ```

   Commit `package.json`, `package-lock.json` and `sample/released-templates.json`, open a PR, and merge after checks pass. The release workflow stops before approval when a built-in template's hash is missing from that list. To withdraw trust from a released built-in, for example because a site it uses changed owner, remove its hash in a later release. **ImageFlow → About ImageFlow** shows this version; packaged checks verify it against the Mac bundle and running app.

2. From the merged commit on `main`, create and push the matching tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v1.0.0 -m "ImageFlow 1.0.0"
   git push origin v1.0.0
   ```

   `v1.0.0` must match `package.json` version `1.0.0` exactly. A mismatch or a commit outside `origin/main` fails before release approval or credential access. Semver build metadata (`+...`) is rejected because the updater does not treat it as a distinct version; use a new version or a prerelease suffix instead.

3. In **Actions → Release**, review the tagged commit and approve the pending **release** environment deployment. The Mac job validates the secrets before building, builds without Apple credentials, signs with a temporary keychain, removes it before packaged tests, then obtains temporary credentials again for notarization. Once both the signed-app checks and signed-upgrade tests succeed, it publishes the release and starts the Pages feed refresh. Wait for both workflows to succeed. The published release contains:

   ```text
   ImageFlow-1.0.0-mac-arm64.zip
   ImageFlow-1.0.0-arm64.dmg
   ```

   The ZIP is for Squirrel.Mac updates and retains `ImageFlow.app` at its root. The DMG is for first installs.

## Published downloads

After approval and successful automated checks, the release is public under **GitHub → Releases**. Review the generated notes and download the DMG for an installation spot check. On an Apple silicon Mac that has not run ImageFlow before, open it, drag ImageFlow to Applications, eject the disk image, then launch the installed app. Check that Gatekeeper accepts it, **About ImageFlow** shows the expected version, and a new book made from a built-in template opens, accepts a few imported photos and exports a proof PDF.

No separate **Publish release** click is needed for beta or stable tags. Keep both assets attached under their original names. The built-in updater uses the public ZIP. Publishing a release does not add update support to builds that predate the updater.

## Test tags and retries

For a full workflow rehearsal, use an unused prerelease version such as `0.1.0-test.1`, merge that version through a PR onto `main`, then tag the merged commit `v0.1.0-test.1`. Such tags produce drafts also marked **prerelease**. Leave the test draft unpublished. Drafts and rehearsal prereleases (`-test.N`) are excluded from both update feeds. Published `-beta.N` releases enter only the beta feed. A tag on an unmerged feature/test branch is deliberately rejected before credential access; no bypass is provided for rehearsals.

If the failure is transient or external, such as an Apple service outage, a network error or misconfigured secrets, fix that cause and rerun the failed jobs for the same tag. A rerun uses the original tagged commit and its workflow/scripts. If a fix needs a code change, merge it onto `main`, bump to a new version (for example, the next prerelease), and push a new matching tag. Leave any failed draft unpublished or delete it; do not move an existing release tag.

Existing draft assets can be replaced on a rerun. Draft creation requires an explicit not-found response and a successful complete lookup of pending drafts; authentication, network, rate-limit and server errors stop the job. Multiple drafts for the same tag also stop the job for manual resolution. The workflow refuses to modify an already published release; release a new version for a published-build fix.

Signing and notarization child output streams directly to Actions, including before failure or cancellation. The notarization library still waits internally for Apple's final response; if a run is interrupted before it reports a submission ID, use `xcrun notarytool history` with the same API credentials to find it, then `xcrun notarytool log <id>` to inspect it.

Signing credentials are imported only for the separate signing and notarization operations and removed immediately afterward; the API key file exists only during notarization. Only the ZIP and DMG pass to the job that stages the draft; publication follows automatically after it validates both assets. Publication and feed refresh use separate jobs, so a failed feed dispatch can be retried without modifying the published release. Action artifacts are retained for seven days; the assets attached to the draft release remain there.

## Stable and beta updates

The app reads small JSON feeds hosted on GitHub Pages:

- Stable: `https://wirhabenzeit.github.io/imageflow/updates/stable/darwin-arm64/RELEASES.json`
- Beta: `https://wirhabenzeit.github.io/imageflow/updates/beta/darwin-arm64/RELEASES.json`

The signed ZIPs remain GitHub Release assets. **Settings → General → Updates → Channel** selects Stable or Beta. Stable is the default for a fresh stable installation; a fresh beta installation defaults to Beta. An explicit preference survives upgrades. Beta receives both beta and final releases, choosing the greatest semantic version. Stable receives final releases only. Switching to Stable never downgrades a newer beta: stable updates resume once a newer final release exists. Channel changes are disabled while a check/download or staged update is in progress.

The app compares semantic versions before starting Electron's native updater. It validates the channel head against a versioned per-release payload, then asks Squirrel.Mac to download, verify and install the ZIP using server mode. This handles `1.0.0-beta.10 → 1.0.0` correctly; Squirrel's static-JSON numeric comparison would consider that a downgrade. No separate updater framework or dynamic update server is needed. The SHA-256 digest and size in the payload are informational: Squirrel downloads the ZIP from its URL and accepts it only if the contained app satisfies the running app's code-signing requirement (same Developer ID team and bundle ID). That signature check, not the digest, protects installation.

**Pages** regenerates both channel heads after every push to `main` and after a release is published, edited, unpublished or deleted. It can also run manually. It reads all release pages, ignores drafts, rehearsal/alpha/RC versions and incomplete platform assets, validates the expected GitHub ZIP URL and GitHub's SHA-256 asset digest, and selects by SemVer rather than publication date. An API or metadata error stops deployment, preserving the existing site. With no published release, the feed explicitly reports no available version. Apple silicon is shipped; the x64 feed remains empty until matching x64 assets exist.

Publishing, editing, unpublishing or deleting a release starts the **Pages** workflow on `main`; it doesn't deploy from the release's tag. (For `v1.0.0-beta.3`, deployments made in the tag context reported success but GitHub Pages kept serving the previous site, so the beta feed stayed empty until `main` deployed again.) Every deployment ends with a **verify** job that waits for the live stable and beta feeds to announce the versions just built, so a deployment that doesn't go live turns the run red. After publishing, check that this run succeeded.

GitHub Pages is configured to use Actions, with its protected `github-pages` environment allowing `main` and `v*` tags. After this PR merges:

1. Keep the default site URL above stable (feed requests refuse redirects, so adding a Pages custom domain would make every check fail until the app's feed URL changes) and retain the environment's `main` and `v*` policies (published-release events run in their tag context).
2. Run **Actions → Pages** from `main`. Check that both URLs return JSON without credentials. Published beta assets must also be downloadable without credentials.
3. Keep `.github/workflows/pages.yml` as the only Pages deployment workflow. It builds the documentation, copies that output into `.build/pages/`, and generates `updates/` alongside it before uploading one artifact. Every main push and release refresh rebuilds both components. PR builds validate without deploying. Feed/API or documentation build failures stop the entire deployment, preserving the previously published site.

Publishing either beta or stable uses the same path: update package files, merge onto `main`, push the matching tag, and approve the protected release environment. Successful tests, signing and notarization automatically lead to publication and a Pages refresh. The workflow uses an explicit `workflow_dispatch`: publishing with `GITHUB_TOKEN` does not trigger another release-event workflow. Pages verifies the live feeds after deployment; if its run fails, retry that Pages run rather than publishing again.

Until the first stable release exists, betas are automatically marked as GitHub's latest full release so the repository shows the current download. After that, betas are marked as prereleases and leave the stable release as Latest. The version decides the updater channel regardless of that GitHub flag: `-beta.N` enters only the beta feed, and final versions enter stable and beta. Rehearsal (`-test.N`) and other experimental prerelease tags stay unpublished drafts.

## Automatic checks and safe quit

Background signature/location checks run after the first usable window opens. Packaged Developer ID signed macOS apps then check at launch and every four hours; development and ad-hoc builds never contact the feed. Automatically checking is enabled by default and stored on this Mac. Disabling it stops future checks, while manual **ImageFlow → Check for Updates…** still works. General settings shows progress, up-to-date and offline/error states. Translocated/Downloads and unwritable copies have actionable location/permissions hints; writable external drives are allowed.

A downloaded update produces one non-modal **Restart to Update** notice in the focused or most recent app window. **Later** dismisses it throughout the app; the menu and settings restart actions remain. Restart enters ordinary Quit: Markdown windows flush with their existing conflict/cancel handling; ordinary fields commit on blur and pending writes drain. Active page editors and invalid/failed drafts keep the app open. Crashed/loading windows do not prevent quitting. A non-answering window offers Keep Open or explicit Quit Anyway, warning that unsaved input may be lost. Only after ordinary cleanup settles writers, releases locks and shuts down MCP does the app request install/relaunch.

Squirrel also applies a staged update on ordinary Quit, without requesting relaunch. Later dismisses the notice rather than cancelling staging. A cancelled restart clears only the relaunch request. [Electron documents that a downloaded update applies on the next start](https://www.electronjs.org/docs/latest/api/auto-updater#autoupdaterquitandinstall).

## Automated signed upgrade test

**Signed upgrade test** performs actual native installation on a fresh Apple silicon runner, without publishing a GitHub Release. It runs with release preparation or on an existing trusted version tag. Its isolated app has bundle ID `ch.wirhabenzeit.imageflow.upgrade-test`, a separate book/profile, a compiled loopback-only feed and a test-only debugging port. Production builds cannot redirect their feed using environment variables. Fixtures do not register the production document types.

The workflow builds four versions without Apple credentials, signs them using the existing temporary-keychain helper, removes signing credentials, creates a fresh one-day self-signed loopback certificate (a leaf, `CA:FALSE`, trusted for SSL only, so it cannot vouch for any other host), trusts it in the ephemeral runner's system trust settings (passwordless `sudo`; changing the user's trust settings would wait for a confirmation dialog nobody can answer), and runs three real transitions:

1. `9.9.9-beta.1 → 9.9.9-beta.2` on Beta.
2. `9.9.9-beta.2 → 9.9.9` on Beta (same-version final release).
3. `9.9.9 → 9.9.10` on Stable.

It checks stable/beta isolation, offline recovery, actual ZIP download, native installation/relaunch, saved book content, lock reacquisition, up-to-date/no-downgrade behavior and MCP SDK reconnection using the same configured bridge command. Native updater events and `quitAndInstall` are never mocked. It uploads `signed-upgrade-report.json`, then removes local TLS trust. That report must say `passed: true`; green mocked UI tests are separate evidence.

All three transitions passed locally on 2026-11-14 using the installed Developer ID identity, without exporting its private key. The [recorded report](validation/signed-upgrade-2026-11-14.json) includes artifact hashes and identifies the working-tree source used. The temporary local TLS trust was removed and independently checked afterwards. These fixtures were signed, not notarized.

The release workflow runs this test automatically and requires it to succeed before preparing the draft release. It reuses the existing tag-only protected `release` environment and its three signing secrets; no extra environment, key export or credential copy is required. Rehearsal tags (`-test.N`) stay drafts; normal beta and stable tags publish automatically after all required jobs succeed. The standalone signed-upgrade workflow never publishes a release.

After the workflow exists on a trusted version tag, it can also be rerun on that tag without creating or publishing another release:

```sh
gh workflow run upgrade-test.yml --ref v1.0.0-beta.1
```

Choose an actual existing tag containing the workflow and approve the existing release environment. The tag's commit must be on main. Main/feature-branch dispatches are skipped: moving a checkout to main does not change GitHub's tag-only environment authorization. For current untagged code, use the local one-command test below.

Both entry paths verify main ancestry before credential access and retain the existing environment's version-tag policy. Fixtures are signed but not notarized/quarantined; this test establishes native update behavior, not first-download Gatekeeper acceptance.

For a Mac with an installed Developer ID identity, one local command builds, signs and tests all fixtures and removes local test-server trust afterwards:

```sh
npm run test:upgrade:signed
```

It selects the sole installed Developer ID, or accepts `APPLE_SIGNING_IDENTITY` when multiple identities are available. Private keys stay in Keychain; nothing is exported. Use a disposable Mac account for routine runs. The staged developer commands used by CI are:

```sh
npm run build
npm run test:unit
npm run test:updates
node scripts/upgrade-fixtures.mjs prepare
node scripts/upgrade-fixtures.mjs build
node scripts/mac-credentials.mjs sign-fixtures
node scripts/upgrade-fixtures.mjs trust
node scripts/test-signed-upgrade.mjs
node scripts/upgrade-fixtures.mjs untrust
```

`untrust` removes the certificate from the keychain and deletes it with its key. `prepare` and `trust` first remove anything a killed earlier run left behind, so an interrupted local run is cleaned up by the next one; run `node scripts/upgrade-fixtures.mjs untrust` yourself if you won't run the test again. Prefer the workflow, which performs trust cleanup even after failure. Lightweight tests cover feed generation, semantic ordering, channel preferences, failures, notices, field save/cancel/recovery and crashed/unresponsive windows.

## Remaining release acceptance (#74)

Record the first successful signed-upgrade workflow run and its report under #74. Before V1 ships, also record a real downloaded notarized app's clean-Mac Gatekeeper acceptance (#73), the live Pages feeds and public ZIP checks, a configured desktop MCP client's reconnection, and macOS logout/restart/shutdown with saved books. These environmental checks are separate from the automated SDK/installer result. No public throwaway release is needed to validate the installer; normal beta distribution validates the hosted feed path. Keep #74 open until its evidence is recorded.
