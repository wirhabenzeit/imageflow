# Releasing ImageFlow for Mac

The **Release** workflow builds Apple silicon downloads when a `v*.*.*` tag is pushed. It checks the tag against `package.json` and verifies that the tagged commit belongs to `origin/main`, then builds and tests the Developer ID signed app, notarizes and staples the app and DMG, then attaches the ZIP and DMG to a **draft** GitHub Release with generated notes. Publishing is a manual step. Ordinary PR checks stay separate.

The six signing secrets in [Mac signing and notarization](signing.md) must be configured in the protected **release** environment first, with no repository-level copies. It accepts only `v*` tags, requires approval by `wirhabenzeit`, and disables administrator bypass. Before the first public release, make this repository public so downloads and the planned `update.electronjs.org` feed are accessible without credentials.

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

3. In **Actions → Release**, review the tagged commit and approve the pending **release** environment deployment. The Mac job validates the secrets before building, builds without Apple credentials, signs with a temporary keychain, removes it before packaged tests, then obtains temporary credentials again for notarization. Wait for the workflow to succeed. Its final job links to the draft, which contains:

   ```text
   ImageFlow-1.0.0-mac-arm64.zip
   ImageFlow-1.0.0-arm64.dmg
   ```

   The ZIP is for Squirrel.Mac updates and retains `ImageFlow.app` at its root. The DMG is for first installs.

## Review and publish

Open the draft under **GitHub → Releases**, review the generated notes, and download the DMG. On an Apple silicon Mac that has not run ImageFlow before, open it, drag ImageFlow to Applications, eject the disk image, then launch the installed app. Check that Gatekeeper accepts it, **About ImageFlow** shows the expected version, and a sample book opens and exports a proof PDF.

After the workflow and installation check succeed, click **Publish release**. Keep both assets attached under their original names. The built-in updater uses the public ZIP. Publishing a release does not add update support to builds that predate the updater.

## Test tags and retries

For a full workflow rehearsal, use an unused prerelease version such as `0.1.0-test.1`, merge that version through a PR onto `main`, then tag the merged commit `v0.1.0-test.1`. Such tags produce drafts also marked **prerelease**. Leave the test draft unpublished. Drafts and prereleases are excluded from the public update feed. A tag on an unmerged feature/test branch is deliberately rejected before credential access; no bypass is provided for rehearsals.

If the failure is transient or external, such as an Apple service outage, a network error or misconfigured secrets, fix that cause and rerun the failed jobs for the same tag. A rerun uses the original tagged commit and its workflow/scripts. If a fix needs a code change, merge it onto `main`, bump to a new version (for example, the next prerelease), and push a new matching tag. Leave any failed draft unpublished or delete it; do not move an existing release tag.

Existing draft assets can be replaced on a rerun. Draft creation requires an explicit not-found response and a successful complete lookup of pending drafts; authentication, network, rate-limit and server errors stop the job. Multiple drafts for the same tag also stop the job for manual resolution. The workflow refuses to modify an already published release; release a new version for a published-build fix.

Signing and notarization child output streams directly to Actions, including before failure or cancellation. The notarization library still waits internally for Apple's final response; if a run is interrupted before it reports a submission ID, use `xcrun notarytool history` with the same API credentials to find it, then `xcrun notarytool log <id>` to inspect it.

Signing credentials are imported only for the separate signing and notarization operations and removed immediately afterward; the API key file exists only during notarization. Only the ZIP and DMG pass to the job with permission to write the draft release. Action artifacts are retained for seven days; the assets attached to the draft release remain there.

## Automatic updates and acceptance (#74)

Once background signature/location checks complete, packaged macOS apps with a verified Developer ID signature check the public `wirhabenzeit/imageflow` feed at launch and every four hours. Development and ad-hoc builds do not initialize the updater. The app uses Electron’s `autoUpdater` through `update-electron-app`, with its default modal notification disabled. Downloads happen in the background; a non-modal **Restart to Update** notice appears when the download is ready. **Later** dismisses the notice throughout the app; only the focused or most recent app window shows it, and the restart command remains available in the app menu and General settings.

**ImageFlow → Check for Updates…** opens General settings, where progress, up-to-date and offline/error feedback appears. **Automatically check for updates** defaults on and is stored on this Mac. Turning it off stops future automatic checks; manual checks still work, and an update already being downloaded can finish. Translocated and Downloads launches explain how to move the app into Applications. Unwritable locations have a separate message about permissions, Applications or ~/Applications; writable external drives are allowed. A signed app must be installed in a writable location to update.

Restart first requests an ordinary Quit. Markdown source windows flush their latest input using their existing error/conflict/cancel handling. Book windows commit plain fields on blur and drain pending saves. They reject quitting while an active page editor, invalid field or failed save needs attention. Crashed or still-loading renderers do not block Quit; a renderer that does not answer offers Keep Open or an explicit Quit Anyway choice before its window is destroyed. A rejected quit keeps the app usable and the update ready for a later retry. Only after the windows close, writers settle, book locks release and MCP shuts down does the app call `quitAndInstall()`. Books are cleanly closed; reopen them from Recents after relaunch.

A downloaded update is staged by Squirrel.Mac. **Later** dismisses the notice; it does not cancel staging. Ordinary Quit also applies the staged update, without requesting relaunch. Cancelling a restart keeps the app open and clears only the relaunch request; the staged update remains. [Electron documents that a downloaded update is applied on the next start](https://www.electronjs.org/docs/latest/api/auto-updater#autoupdaterquitandinstall).

Local implementation checks:

```sh
npm run build
npm run test:unit
node scripts/stage-desktop.mjs
node scripts/smoke-updates.mjs
node scripts/smoke-quit.mjs
node scripts/smoke-project-lifecycle.mjs
node scripts/smoke-markdown-editor.mjs
```

`smoke-updates.mjs` simulates native updater events and intercepts installation. It checks the preference, manual feedback, notice, cancelled quit with pending page text, successful save, and lock/MCP cleanup before installation. These checks do **not** establish signed download, installation, relaunch or real-client reconnection.

Before closing #74 or shipping V1, record an actual two-version upgrade in the issue:

1. Choose two stable SemVer versions built by the release workflow with the same Developer ID. Record versions, commits, workflow runs, signing identity/team, macOS version, ZIP/DMG links and the public feed URL (`https://update.electronjs.org/wirhabenzeit/imageflow/darwin-arm64/<installed-version>`). Both versions must already include the updater.
2. Install the older notarized DMG on a clean Apple silicon Mac by dragging it into Applications; eject the disk image. Configure a real MCP client once and record its launch configuration.
3. Publish the newer stable release with its original ZIP and DMG names. Coordinate this publication explicitly: the public service ignores draft and prerelease releases, so two draft artifacts cannot prove delivery. Do not publish throwaway stable releases as part of an automated test.
4. Check discovery and background download using the real public feed. Verify **Restart to Update**, **Later**, and the retained menu/settings restart command. Record any service cache delay.
5. Try restarting with pending inline text, a failed save and a conflicted Markdown source. Confirm the app stays open with the draft intact when the edit cannot safely close. Resolve/save, restart, and confirm the expected version relaunches, saved text survives and books reopen without stale locks.
6. Check ordinary Quit after **Later**, including after cancelling a restart: the staged update should apply and the app should remain closed until launched manually. Verify macOS logout/restart/shutdown with saved books does not get blocked by the quit handshake.
7. Verify manual checks while automatic checks are off, the persisted preference after relaunch, up-to-date feedback, and offline/error recovery. Run from a DMG/translocated location and verify the move-to-Applications hint.
8. Reconnect the configured real MCP client without repeating setup. Confirm the installed executable path remains unchanged and a book can be inspected and edited. Attach results and failures to #74; leave it open until this evidence is complete.
