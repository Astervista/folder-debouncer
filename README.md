# folder-debouncer

Mirror a folder somewhere else, but **hold back changes until you say they are done**.

Tools that watch a folder (dev servers, sync clients, file-based deploys, other watchers) often react to every
single file write. When a build rewrites dozens of files, they see a half-written tree, reload several times, or
crash on a missing chunk. `folder-debouncer` sits in between: it keeps a mirror of your project in which the build
output only changes **all at once**, when a *commit trigger* file is written at the end of the build.

```
 project/                     output folder
 ├── src/        ── symlink ─▶ src/            always live
 ├── package.json ─ symlink ─▶ package.json    always live
 └── dist/       ── copy ───▶ dist/           changes held back...
     └── build-complete  ─────────────────────▶ ...until this file changes, then flushed at once
```

- **Watched** paths are copied. Every change to them is snapshotted and queued, then applied in one go when a
  commit trigger changes (or when you press <kbd>F</kbd>).
- **Everything else** is symlinked, so it costs nothing and is always up to date.
- **Ignored** paths are left out of the mirror.

It runs as a small full-screen terminal app showing what is pending and what was flushed.

> [!NOTE]
> macOS only. File events come from FSEvents through a small native helper, which is bundled prebuilt
> for Apple Silicon and Intel.

## Install

Run it without installing:

```sh
npx folder-debouncer
```

Or install it globally, which puts the `folder-debouncer` command on your `PATH`:

```sh
npm install --global folder-debouncer
folder-debouncer --help
```

It can also be a dev dependency, run from an npm script:

```sh
npm install --save-dev folder-debouncer
```

```json
{
  "scripts": {
    "debounce": "folder-debouncer"
  }
}
```

Requires Node.js 18 or newer.

## Quick start

```sh
cd my-project
folder-debouncer --init     # writes a starter debouncer.json
# edit debouncer.json
folder-debouncer            # reads ./debouncer.json
```

Then point whatever consumes the files at the output folder, and make your build write the commit trigger file
last (for example, `touch dist/build-complete` at the end of the build script).

## Configuration

`debouncer.json`:

```json
{
  "$schema": "https://unpkg.com/folder-debouncer/config.schema.json",
  "linkFolder": ".",
  "outputFolder": "../my-project-debounced",
  "watch": ["dist"],
  "commitTriggers": ["dist/build-complete"],
  "ignore": [".git"]
}
```

| Option           | Required | Description                                                                                                                  |
|------------------|----------|------------------------------------------------------------------------------------------------------------------------------|
| `linkFolder`     | yes      | The folder to mirror.                                                                                                        |
| `outputFolder`   | yes      | Where the mirror is created. Must not be inside the link folder, nor contain it.                                             |
| `watch`          | no       | Files or folders that are copied, with their changes held back until a flush.                                               |
| `commitTriggers` | no       | Files that flush all pending changes whenever they are created, changed or deleted. They can be inside a watched folder or not. |
| `ignore`         | no       | Files or folders left out of the mirror entirely.                                                                            |

`linkFolder` and `outputFolder` are relative to the config file; `watch`, `commitTriggers` and `ignore` are relative
to `linkFolder`. Each of the last three accepts a single string or an array. The `$schema` line gives you
autocompletion and validation in most editors.

> [!WARNING]
> The output folder belongs to folder-debouncer. If it is not empty at startup you are asked before its contents
> are deleted, and it is **deleted when folder-debouncer exits**. Don't point it at a folder you care about.

## Usage

```
folder-debouncer [options] [config]

  config               Path to the config file (default: ./debouncer.json)
  -c, --config <path>  Same as the config argument
      --init           Create a starter debouncer.json in the current folder
  -h, --help           Show help
  -v, --version        Show the version
```

While it runs:

| Key                     | Action                                         |
|-------------------------|------------------------------------------------|
| <kbd>F</kbd>            | Flush pending changes now                      |
| <kbd>R</kbd>            | Restart, reloading the config file             |
| <kbd>↑</kbd> <kbd>↓</kbd>, mouse wheel | Scroll the log                  |
| <kbd>H</kbd>            | Help                                           |
| <kbd>X</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd> | Exit and remove the output folder |

## How it works

On start, the link folder is mirrored into the output folder: watched paths are copied, the folders leading to
them are recreated, and everything else is symlinked at the highest possible level.

While running, a native FSEvents watcher reports changes:

- Inside a **watched** path, each change is snapshotted to a private cache right away, so the state at the time of
  the change is what gets flushed, and queued. Renames are detected and applied as moves.
- **Outside** watched paths, additions and removals next to the mirrored folders are symlinked or unlinked
  immediately. Anything deeper is already visible through a symlink.
- When a **commit trigger** changes, the queue is applied to the output folder in order.

## Limitations

- macOS only.
- The mirror is one-way: changes made inside the output folder are not copied back, and may be overwritten.
- Folders moved into a watched path are copied as they are at flush time, since their contents produce no events.
- Mouse support is on so the wheel can scroll the log, which means most terminals need a modifier key to select text
  (<kbd>Option</kbd> in iTerm2; check your terminal's settings).

## Development

```sh
npm install
npm run build        # compiles TypeScript to dist/ and the native watcher to watcher/watcher
npm test             # unit and integration tests (they create temporary folders and watch them)
npm run example      # runs the example in example/
```

The native watcher needs the Xcode Command Line Tools (`xcode-select --install`). Published packages include
it prebuilt, so users don't need them.

To release: bump the version in `package.json`, update `CHANGELOG.md`, then `npm publish`. `prepack` rebuilds
everything first.

## License

[MIT](LICENSE)
