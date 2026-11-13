# Releasing ImageFlow for Mac

The **Release** workflow builds Apple silicon downloads when a `v*.*.*` tag is pushed. It checks the tag against `package.json`, builds and tests the Developer ID signed app, notarizes and staples the app and DMG, then attaches the ZIP and DMG to a **draft** GitHub Release with generated notes. Publishing is a manual step. Ordinary PR checks stay separate.

The six signing secrets in [Mac signing and notarization](signing.md) must be configured first. Before the first public release, make this repository public so downloads and the planned `update.electronjs.org` feed are accessible without credentials.

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

   `v1.0.0` must match `package.json` version `1.0.0` exactly. A mismatch fails before the Mac build or credential import.

3. Wait for **Actions → Release** to succeed. Its final job links to the draft, which contains:

   ```text
   ImageFlow-1.0.0-mac-arm64.zip
   ImageFlow-1.0.0-arm64.dmg
   ```

   The ZIP is for Squirrel.Mac updates and retains `ImageFlow.app` at its root. The DMG is for first installs.

## Review and publish

Open the draft under **GitHub → Releases**, review the generated notes, and download the DMG. On an Apple silicon Mac that has not run ImageFlow before, open it, drag ImageFlow to Applications, eject the disk image, then launch the installed app. Check that Gatekeeper accepts it, **About ImageFlow** shows the expected version, and a sample book opens and exports a proof PDF.

After the workflow and installation check succeed, click **Publish release**. Keep both assets attached under their original names. The updater work in #74 will use the public ZIP; publishing a release alone does not add update support to older builds.

## Test tags and retries

For a workflow rehearsal, use a separate test branch with a prerelease version such as `0.1.0-test.1`, then push `v0.1.0-test.1`. Such tags produce drafts also marked **prerelease**. Keep the test version out of the production branch and leave the draft unpublished. Drafts and prereleases are excluded from the public update feed.

If signing, tests, notarization or upload fails, fix the cause and rerun the failed jobs for the same tag. Existing draft assets can be replaced on a rerun. The workflow refuses to modify an already published release; release a new version for a published-build fix. Do not move a released tag to a different commit.

Signing credentials are imported only in the Mac job's temporary keychain and removed in its final cleanup step. Only the ZIP and DMG pass to the job with permission to write the draft release. Action artifacts are retained for seven days; the assets attached to the draft release remain there.
