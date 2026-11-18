# Follow-up to the 18 November 2026 beta recap

## Photo availability (F-012)

The photos were not deleted: a read-only check found all 163 linked originals on disk. The persisted approval and cache namespaces used `stat.dev`, which can change across a macOS restart. This caused unchanged links to appear unapproved and hid their cache records.

On macOS, the new namespace uses the volume UUID, directory inode and nanosecond birth time. Volume lookup resolves APFS firmlinks through `df` and reads the UUID with `diskutil`; lookups are shared per device during the process lifetime. Volumes without a UUID and other platforms retain their existing device-based identity.

When there is no registry in the new namespace, migration reads legacy device-number records with exactly the same directory inode and birth time. It merges nonconflicting entries, retains legacy files, and publishes the new registry atomically. Conflicting entries grant nothing. Once published, the new registry is authoritative: removed permissions cannot return from legacy records. Copies and recreated directories do not inherit access based on their name or manifest.

The source cache uses the same migration. Original paths still have to match their grants exactly, and cached bytes still undergo digest checks. No book manifest or original photo needs to change.

## Folder recovery (F-013)

An explicit Locate Folder selection can reapprove a registered linked original at its exact canonical path under the selected folder, even without approvals or cache metadata. Different paths still require a known matching digest. Same-name replacements and symlink escapes do not qualify. The native chooser now treats packages as directories and labels confirmation “Locate”. The reported native disabled-button behavior still needs a manual retest; the backend recovery has regression coverage.

## MCP improvements

- F-019: `check_book` omits template declarations by default, both at the top level and within the render summary. `includeTemplate: true` requests the full result. Internal planning caches and `get_authoring_context` retain declarations.
- F-023, partial: dry runs bypass the editor mutation lease. Actual saves retain the existing editor protection. Naming the active editor, showing editing state in inspection, and allowing saves to unrelated pages remain outstanding.

## Verification and remaining scope

Regression coverage includes migration from multiple legacy device keys, available linked photos after reopening, retained cached photos when originals disappear, rejection of conflicting/different-birth records, preservation of revocations, and exact-original folder recovery without a cache. Tests use isolated temporary books.

The build and all 698 unit tests pass; the focused photo regression suite passes all 23 tests. The desktop linked-source smoke covers photo, Markdown and parameter-file refresh, cached missing states, export consistency and portable Save a Copy. The MCP desktop smoke also passes, including a dry run while a text editor holds an unsaved human draft; the draft stays unchanged and actual saves remain blocked. Its Settings-window lookup now waits for the Settings page instead of accepting an unrelated render window.

An actual Mac reboot, native Locate Folder confirmation, and installed-app upgrade remain unverified. The verification used sample books and isolated profiles.

F-016/F-024 (client schema discovery and oversized validation errors), F-020/F-021, editor identification and narrower locking, rendering/presentation reports F-008/F-009/F-010/F-025, and the other template/API findings remain open. This change does not claim to resolve them.
