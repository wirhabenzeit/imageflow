# Releasing ImageFlow for Mac

The **Release** workflow builds Apple silicon downloads when a `v*.*.*` tag is pushed. It checks the tag against `package.json` and verifies that the tagged commit belongs to `origin/main`, then builds and tests the Developer ID signed app, notarizes and staples the app and DMG, then attaches the ZIP and DMG to a **draft** GitHub Release with generated notes. Publishing is a manual step. Ordinary PR checks stay separate.

The six signing secrets in [Mac signing and notarization](signing.md) must be configured in the protected **release** environment first, with no repository-level copies. It accepts only `v*` tags, requires approval by `wirhabenzeit`, and disables administrator bypass. Before the first public release, make this repository public so downloads and the planned `update.electronjs.org` feed are accessible without credentials.

## Prepare and tag

1. On a release-preparation branch, choose the version and update both package files:

   ```sh
   npm version 1.0.0 --no-git-tag-version
   ```

   Commit `package.json` and `package-lock.json`, open a PR, and merge after checks pass. **ImageFlow → About ImageFlow** shows this version; packaged checks verify it against the Mac bundle and running app.

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

After the workflow and installation check succeed, click **Publish release**. Keep both assets attached under their original names. The updater work in #74 will use the public ZIP; publishing a release alone does not add update support to older builds.

## Test tags and retries

For a full workflow rehearsal, use an unused prerelease version such as `0.1.0-test.1`, merge that version through a PR onto `main`, then tag the merged commit `v0.1.0-test.1`. Such tags produce drafts also marked **prerelease**. Leave the test draft unpublished. Drafts and prereleases are excluded from the public update feed. A tag on an unmerged feature/test branch is deliberately rejected before credential access; no bypass is provided for rehearsals.

If the failure is transient or external, such as an Apple service outage, a network error or misconfigured secrets, fix that cause and rerun the failed jobs for the same tag. A rerun uses the original tagged commit and its workflow/scripts. If a fix needs a code change, merge it onto `main`, bump to a new version (for example, the next prerelease), and push a new matching tag. Leave any failed draft unpublished or delete it; do not move an existing release tag.

Existing draft assets can be replaced on a rerun. Draft creation requires an explicit not-found response and a successful complete lookup of pending drafts; authentication, network, rate-limit and server errors stop the job. Multiple drafts for the same tag also stop the job for manual resolution. The workflow refuses to modify an already published release; release a new version for a published-build fix.

Signing and notarization child output streams directly to Actions, including before failure or cancellation. The notarization library still waits internally for Apple's final response; if a run is interrupted before it reports a submission ID, use `xcrun notarytool history` with the same API credentials to find it, then `xcrun notarytool log <id>` to inspect it.

Signing credentials are imported only for the separate signing and notarization operations and removed immediately afterward; the API key file exists only during notarization. Only the ZIP and DMG pass to the job with permission to write the draft release. Action artifacts are retained for seven days; the assets attached to the draft release remain there.
