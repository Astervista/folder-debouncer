# folder-debouncer

**Rebuild when you say so.**

Modern editors save as you type. `ng serve`, `tsc --watch`, webpack and friends rebuild on every save. Put the two
together and your compiler restarts on every keystroke: the fans spin up, the terminal fills with errors about code
you haven't finished writing, and the browser reloads a half-written feature.

folder-debouncer puts a gate between your editor and your watcher. Your dev server runs in a mirror of your
project; your edits pile up in front of it, and reach it **all at once, when you flush**, with a key press or an
editor shortcut. You keep autosave, you keep live reload, and you decide when a rebuild happens.

```
   your project (you edit here)            mirror (your dev server runs here)
   ├── src/          ── copied ───┐        ├── src/            ← only changes on flush
   │    edits pile up here        │        │
   ├── node_modules/ ── symlink ──┼──────▶ ├── node_modules/   ← always live
   ├── angular.json  ── symlink ──┘        ├── angular.json
   └── .debouncer-flush                    └── ...
          ▲
          └── debouncer --flush   (bound to a key in your editor)
```

> [!NOTE]
> macOS only. File events come from FSEvents through a small native helper, bundled prebuilt for Apple Silicon
> and Intel.

## Contents

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [Flush from your editor](#flush-from-your-editor)
- [Configuration](#configuration)
- [Command line and keys](#command-line-and-keys)
- [How it works](#how-it-works)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development)

## Why

The usual answers don't quite work:

| Workaround                                           | Problem                                                                                                         |
|------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| Turn off autosave                                    | JetBrains IDEs can't fully turn it off: they still save when you switch windows, run, or use version control. And you lose autosave. |
| Delay rebuilds (webpack `aggregateTimeout`, polling) | Only postpones the rebuild. Pause for a second mid-edit and it rebuilds anyway.                                 |
| Stop and restart the dev server                      | Slow, and you lose incremental builds.                                                                          |
| Tool-specific APIs                                   | Work for one bundler, need code, and `ng serve` / `tsc --watch` don't offer a manual mode.                      |

folder-debouncer works with **any** watcher (Angular CLI, `tsc --watch`, webpack, esbuild, Vite, nodemon, test
runners in watch mode) because it doesn't touch the tool at all. It only controls what the tool gets to see.

## Install

```sh
npm install --global folder-debouncer   # puts the `debouncer` command on your PATH
```

Or try it first:

```sh
npx folder-debouncer --help   # without installing
```

Requires macOS and Node.js 18 or newer. The command is `debouncer`; `folder-debouncer` works too.

Website: [debouncer.astervista.com](https://debouncer.astervista.com)

## Quick start

```sh
cd my-app
debouncer --init
```

This writes a `debouncer.json` that holds back `src/` and mirrors the project into a sibling folder,
`../my-app-debounced`:

```json
{
  "$schema": "https://unpkg.com/folder-debouncer/config.schema.json",
  "linkFolder": ".",
  "outputFolder": "../my-app-debounced",
  "watch": ["src"],
  "commitTriggers": [".debouncer-flush"],
  "ignore": []
}
```

Then, in two terminals:

```sh
# 1. Start the gate (it stays open as a small dashboard)
debouncer

# 2. Run your dev server in the mirror, not in the project
cd ../my-app-debounced
npx ng serve            # or: npx tsc --watch, npm run dev, ...
```

Keep editing in `my-app` as usual. The dashboard counts the changes waiting at the gate. When you're ready,
press <kbd>F</kbd> in the dashboard or run `debouncer --flush` and your dev server rebuilds once, with
everything.

Add `.debouncer-flush` to your `.gitignore`.

## Flush from your editor

Switching to a terminal to press <kbd>F</kbd> gets old quickly. Bind `debouncer --flush` to a shortcut
instead. It writes the commit trigger file, and the running instance flushes. A flush sends whatever is saved on
disk; autosave normally has it there already, but if you trigger it right after typing, save first.

### WebStorm and other JetBrains IDEs

1. **Settings | Tools | External Tools**, click **+**:
   - **Name:** `Flush debouncer`
   - **Program:** `debouncer` (or the full path from `which debouncer` if the IDE can't find it)
   - **Arguments:** `--flush`
   - **Working directory:** `$ProjectFileDir$`
   - Under **Advanced Options**, clear **Open console for tool output** to keep it quiet.
2. **Settings | Keymap**, find **External Tools | Flush debouncer**, and add a shortcut, for example
   <kbd>⌥</kbd><kbd>⌘</kbd><kbd>Enter</kbd>.

### VS Code

`.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Flush debouncer",
      "type": "shell",
      "command": "debouncer --flush",
      "presentation": {"reveal": "never"},
      "problemMatcher": []
    }
  ]
}
```

`keybindings.json` (**Preferences: Open Keyboard Shortcuts (JSON)**):

```json
{
  "key": "alt+cmd+enter",
  "command": "workbench.action.tasks.runTask",
  "args": "Flush debouncer"
}
```

### Anything else

Any tool that can run a command or write a file works: `debouncer --flush`, or simply
`touch .debouncer-flush`. A build script, a git hook or a Raycast/Alfred command can flush too.

## Configuration

`debouncer.json` in the folder you run `debouncer` from (or pass another path).

| Option           | Required | Description                                                                                                            |
|------------------|----------|------------------------------------------------------------------------------------------------------------------------|
| `linkFolder`     | yes      | Your project: the folder you edit.                                                                                     |
| `outputFolder`   | yes      | Where the mirror is created; run your dev server here. It must not be inside the project, nor contain it.              |
| `watch`          | no       | Files or folders whose edits are held back until a flush. They are copied into the mirror. Usually your sources.        |
| `commitTriggers` | no       | Files that flush when they are created, changed or deleted. `--flush` writes the first one.                            |
| `ignore`         | no       | Files or folders left out of the mirror entirely.                                                                      |

`linkFolder` and `outputFolder` are relative to the config file; `watch`, `commitTriggers` and `ignore` are relative
to `linkFolder`. The last three accept a single string or an array. The `$schema` line gives you autocompletion and
validation in most editors.

Everything that is not watched is **symlinked**, so `node_modules`, configs and assets cost nothing to mirror and are
always current. Only what you list in `watch` is gated.

> [!WARNING]
> The mirror belongs to folder-debouncer. If the output folder is not empty at startup you are asked before its
> contents are deleted, and the mirror is **deleted when folder-debouncer exits**. Never point `outputFolder` at a
> folder you care about. Never edit files inside the mirror either: edit the project.

## Command line and keys

```
debouncer [options] [config]

  config               Path to the config file (default: ./debouncer.json)
  -c, --config <path>  Same as the config argument
      --flush          Tell a running instance to flush now
      --init           Create a starter debouncer.json in the current folder
  -h, --help           Show help
  -v, --version        Show the version
```

While the dashboard is open:

| Key                                           | Action                                  |
|-----------------------------------------------|-----------------------------------------|
| <kbd>F</kbd>                                  | Flush: send the pending changes         |
| <kbd>R</kbd>                                  | Restart, reloading `debouncer.json`     |
| <kbd>↑</kbd> <kbd>↓</kbd> or the mouse wheel | Scroll the log                          |
| <kbd>H</kbd>                                  | Help                                    |
| <kbd>X</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd>  | Exit (the mirror is removed)            |

The status bar shows whether changes are pending, how many files were created, modified, renamed or deleted, and
when the last change and the last flush happened.

## How it works

1. **Mirror.** On start, the project is recreated in the output folder: watched paths are copied, the folders
   leading to them are recreated, and everything else becomes a symlink at the highest possible level.
2. **Hold.** A native FSEvents watcher reports every change. For a watched file, a snapshot is taken immediately
   and the change is queued; the mirror is not touched. Renames and moves are detected, including editors' atomic
   saves, and moves to the Trash.
3. **Flush.** When a commit trigger changes, the queue is applied to the mirror in order, in one burst. Your
   dev server sees one batch of changes and rebuilds once.

Outside watched paths nothing is held back: new or deleted files next to the mirrored folders are linked or
unlinked right away, and everything deeper is already visible through a symlink.

## Recipes

**Angular**

```json
{ "linkFolder": ".", "outputFolder": "../my-app-debounced", "watch": ["src"], "commitTriggers": [".debouncer-flush"] }
```

```sh
cd ../my-app-debounced && npx ng serve
```

**TypeScript library or Node app**: the same config, then `npx tsc --watch` (or `nodemon`) in the mirror.

**Monorepo package**: set `linkFolder` to the repository root so workspace links keep working, and `watch` to the
package's sources, for example `"watch": ["packages/web/src"]`.

**Hold back more than sources**: add anything the watcher reacts to, for example
`"watch": ["src", "public", "tsconfig.json"]`.

## Troubleshooting

**The dev server doesn't rebuild after a flush.** Check that it runs in the mirror (`outputFolder`), not in your
project. The dashboard log shows each file written on flush.

**Module resolution errors in the mirror.** `node_modules` is a symlink to your project's copy. Most tools resolve
it transparently. If one complains, try flipping its symlink setting: `preserveSymlinks` in TypeScript and
`angular.json`, `resolve.preserveSymlinks` in Vite, `resolve.symlinks` in webpack.

**My last keystroke is missing after a flush.** The flush sends what is saved on disk. Save before flushing, or let
autosave catch up.

**"Output folder is not empty. Delete its contents?"** Answer <kbd>N</kbd> if the folder isn't a previous mirror;
nothing is touched and the program exits. Then pick another `outputFolder`.

**The screen looks garbled after a crash.** Run `reset`. folder-debouncer restores the terminal on exit and on
errors, but a `kill -9` can't be caught.

## Limitations

- macOS only.
- One way: the mirror follows your project, never the other way round. Changes made inside the mirror are not
  copied back and may be overwritten.
- A folder moved into a watched path is copied as it is at flush time, since its contents produce no events of
  their own.
- The dashboard needs an interactive terminal. It captures the mouse so the wheel can scroll the log, so selecting
  text usually needs a modifier key (<kbd>Option</kbd> in iTerm2; check your terminal's settings).

## Development

```sh
npm install
npm run build        # TypeScript to dist/, native watcher to watcher/watcher
npm test             # unit and integration tests (they create and watch temporary folders)
npm run example      # the example in example/
```

The native watcher needs the Xcode Command Line Tools (`xcode-select --install`). Published packages include it
prebuilt.

To release: bump `version` in `package.json`, update `CHANGELOG.md`, then `npm publish`. `prepack` rebuilds
everything first.

## License

[MIT](LICENSE)
