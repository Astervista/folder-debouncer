# Changelog

## Unreleased

First public release.

### Added
- `debouncer` command (also available as `folder-debouncer`), usable with `npx` or a global install, with `--config`, `--init`, `--help` and `--version`.
- `--flush`, to flush a running instance from an editor shortcut or a script.
- `--init` writes a config for the common setup: `src/` held back, mirror in a sibling folder, `.debouncer-flush` as
  the trigger.
- The watcher reports it is ready only once FSEvents is delivering events, so edits made right after startup are
  no longer missed.
- The native watcher ships prebuilt as a universal binary (Apple Silicon and Intel).
- Restart (<kbd>R</kbd>) reloads the config file.
- Clear errors for invalid configs, a missing config, unsupported platforms and non-interactive terminals.
- README with editor shortcut recipes, a landing page, an example project, tests and CI.

### Fixed
- Answering **N** to "delete the output folder contents?" deleted them anyway.
- An output folder containing the link folder was accepted, so the sources could be deleted on start or exit.
- Config problems were reported but the program kept going; path checks accepted sibling folders sharing a prefix.
- Changes to folders leading to a watched path were applied to the source folder instead of the output.
- Nothing was mirrored when the link folder path contained a symlink (for example under `/tmp`).
- Commit triggers only worked when they were also inside a watched path.
- Renames crossing the watched/unwatched boundary, or outside watched paths, left stale or missing entries.
- One failing change aborted the whole flush; each change now fails on its own and is logged.
- Items moved out of the folder (for example to the Trash) were never removed from the output.
- Folders moved into the folder lost their contents; renames were missed in large trees (fixed-size inode cache).
- Changes made while the initial copy was running were lost.
- Editors' atomic saves could leave the rename detection confused.
- The log history was duplicated on every resize.
- The terminal was left with a hidden cursor, mouse reporting on or a wiped scrollback after exiting or crashing.
- Ctrl+C did nothing while the startup question was shown, and exiting took two seconds.
- Very narrow terminals froze the program.
- The watcher process could outlive the app, and its errors garbled the screen.
- `graceful-fs` was needed at runtime but listed as a dev dependency. It was replaced with `node:fs`, so the package
  has no runtime dependencies.
