#!/usr/bin/env node
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {Config, ConfigError, configTemplate, DEFAULT_CONFIG_FILE, FLUSH_FILE, loadConfig} from "./config.js";
import {watch, WatcherInstance, WatchEventType} from "./file-watcher.js";
import {Mirror} from "./mirror.js";
import {Status, TerminalUI} from "./ui.js";

const USAGE = `Usage: debouncer [options] [config]

Rebuild when you say so. Mirrors your project into a second folder where your
dev server or compiler runs; edits to watched sources reach it only when you
flush, not on every autosave.

Arguments:
  config               Path to the config file (default: ./${DEFAULT_CONFIG_FILE})

Options:
  -c, --config <path>  Same as the config argument
      --flush          Tell a running instance to flush now (for editor shortcuts)
      --init           Create a starter ${DEFAULT_CONFIG_FILE} in the current folder
  -h, --help           Show this help
  -v, --version        Show the version

Keys while running: F flush, R restart, H help, X or Ctrl+C exit.
Docs: https://debouncer.astervista.com`;

function fail(message: string): never {
    process.stderr.write(`debouncer: ${message}\n`);
    process.exit(1);
}

function version(): string {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
    return pkg.version;
}

function parseArgs(argv: string[]): { configPath: string, flush: boolean } {
    let configPath: string | null = null;
    let flush                     = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        switch (arg) {
            case "-h":
            case "--help":
                process.stdout.write(`${USAGE}\n`);
                process.exit(0);
                break;
            case "-v":
            case "--version":
                process.stdout.write(`${version()}\n`);
                process.exit(0);
                break;
            case "--init":
                init();
                process.exit(0);
                break;
            case "--flush":
                flush = true;
                break;
            case "-c":
            case "--config": {
                const value = argv[++i];
                if (value == null) {
                    fail(`${arg} requires a path.`);
                }
                configPath = value;
                break;
            }
            default:
                if (arg.startsWith("-") || configPath != null) {
                    fail(`Unexpected argument "${arg}". Run debouncer --help for usage.`);
                }
                configPath = arg;
        }
    }
    return {configPath: configPath ?? DEFAULT_CONFIG_FILE, flush};
}

function init() {
    const target = resolve(DEFAULT_CONFIG_FILE);
    if (existsSync(target)) {
        fail(`${target} already exists.`);
    }
    const template = configTemplate(process.cwd());
    writeFileSync(target, JSON.stringify(template, null, 2) + "\n");
    process.stdout.write(`Created ${target}

Next steps:
  1. Check the paths: "watch" lists the sources whose edits are held back.
  2. Add ${FLUSH_FILE} to your .gitignore.
  3. Run debouncer, then start your dev server from ${resolve(template.outputFolder)}
  4. Edit as usual. Press F in the dashboard, or run "debouncer --flush"
     (ideally from an IDE shortcut), to send your changes to the dev server.
`);
}

/** Writes the first commit trigger, which makes a running instance flush. */
function requestFlush(configPath: string) {
    let config: Config;
    try {
        config = loadConfig(configPath);
    } catch (e) {
        fail((e as Error).message);
    }
    const trigger = config.commitTriggers[0];
    if (trigger == null) {
        fail(`--flush needs at least one entry in "commitTriggers" (for example "${FLUSH_FILE}").`);
    }
    mkdirSync(dirname(trigger), {recursive: true});
    writeFileSync(trigger, `${new Date().toISOString()}\n`);
    process.stdout.write(`Flush requested (${relative(process.cwd(), trigger) || trigger}).\n`);
}

// --- Session ---

interface Session {
    config: Config;
    mirror: Mirror;
    watcher: WatcherInstance | null;
    watcherStopped: boolean;
}

let session: Session | null = null;
let starting                = false;

const ui = new TerminalUI({
    onKey,
    getStatus
});

function getStatus(): Status {
    const mirror  = session?.mirror;
    const pending = mirror?.pending ?? [];
    const count   = (event: WatchEventType) => pending.filter(e => e.event == event).length;
    let state: Status["state"];
    if (session == null || session.watcher == null) {
        state = starting ? "starting" : "stopped";
    } else if (session.watcherStopped) {
        state = "stopped";
    } else if (mirror?.flushing) {
        state = "flushing";
    } else {
        state = pending.length > 0 ? "pending" : "idle";
    }
    return {
        state,
        created:     count(WatchEventType.CREATE),
        renamed:     count(WatchEventType.RENAME),
        modified:    count(WatchEventType.MODIFY),
        deleted:     count(WatchEventType.DELETE),
        lastChanged: mirror?.lastChanged ?? null,
        lastFlushed: mirror?.lastFlushed ?? null
    };
}

function flush(reason: string) {
    const mirror = session?.mirror;
    if (mirror == null || mirror.flushing) {
        return;
    }
    if (mirror.pending.length == 0) {
        ui.log(`Nothing to flush (${reason}).`, "flush");
        return;
    }
    ui.log(`Flushing ${mirror.pending.length} change(s) (${reason})...`, "flush");
    mirror.flush();
    ui.log("Flush finished.", "flush");
    ui.scheduleStatus();
}

async function start(configPath: string, firstStart: boolean) {
    starting = true;
    try {
        let config: Config;
        try {
            config = loadConfig(configPath);
        } catch (e) {
            if (firstStart) {
                throw e;
            }
            ui.log(`${(e as Error).message}\nFix the config and press R to try again.`, "error");
            return;
        }

        const mirror = new Mirror(config, (message, type) => ui.log(message, type));
        const current: Session = {config, mirror, watcher: null, watcherStopped: false};
        session = current;

        if (!await mirror.prepareOutput(question => ui.confirm(question))) {
            mirror.dispose();
            shutdown(1, "Aborted: the output folder was left untouched.");
            return;
        }

        // Start watching before copying, so nothing that changes during the copy is missed
        ui.log(`Watching ${config.linkFolder}`, "setup");
        current.watcher = await watch(config.linkFolder, {
            ignored: config.ignore,
            tracked: config.watch,
            onExit:  reason => {
                current.watcherStopped = true;
                ui.log(`The file watcher stopped (${reason}). Press R to restart.`, "error");
                ui.scheduleStatus();
            },
            onError: e => ui.log(`Error while handling a change: ${(e as Error).message}`, "error")
        });
        mirror.initialMirror();

        if (config.watch.length == 0) {
            ui.log("No \"watch\" paths configured: everything is symlinked and nothing is debounced.", "setup");
        }
        mirror.onTrigger = () => flush("commit trigger");
        current.watcher.listen((eventType, fileType, path, oldPath) => {
            mirror.handleEvent(eventType, fileType, path, oldPath);
            ui.scheduleStatus();
        });
        ui.log("Ready.", "setup");
        ui.scheduleStatus();
    } finally {
        starting = false;
    }
}

function stop() {
    const current = session;
    session = null;
    if (current == null) {
        return;
    }
    current.watcher?.close();
    current.mirror.dispose();
}

async function restart(configPath: string) {
    if (starting) {
        ui.log("Still starting, try again in a moment.", "setup");
        return;
    }
    ui.log("Restarting...", "setup");
    stop();
    try {
        await start(configPath, false);
    } catch (e) {
        ui.log(`Restart failed: ${(e as Error).message}`, "error");
    }
    ui.scheduleStatus();
}

let shuttingDown = false;

function shutdown(code: number, message?: string) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    try {
        stop();
    } finally {
        ui.restore();
        if (message) {
            (code == 0 ? process.stdout : process.stderr).write(`${message}\n`);
        }
        process.exit(code);
    }
}

let configPath = DEFAULT_CONFIG_FILE;

function onKey(key: string) {
    switch (key) {
        case "X":
        case "x":
        case "\u0003": // Ctrl+C
            shutdown(0);
            break;
        case "F":
        case "f":
            flush("forced");
            break;
        case "R":
        case "r":
            void restart(configPath);
            break;
        case "H":
        case "h":
            ui.showHelp();
            break;
        case "\u001b[A": // Up arrow
            ui.scroll(1);
            break;
        case "\u001b[B": // Down arrow
            ui.scroll(-1);
            break;
        default:
            ui.log(`Unknown command: ${JSON.stringify(key)}. Press H for help.`, "setup");
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    configPath = args.configPath;
    if (args.flush) {
        requestFlush(configPath);
        return;
    }

    if (process.platform !== "darwin") {
        fail("only macOS is supported (the watcher is built on FSEvents).");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail("needs an interactive terminal.");
    }
    // Validate the config before taking over the screen, so errors stay readable
    try {
        loadConfig(configPath);
    } catch (e) {
        fail(e instanceof ConfigError ? e.message : String(e));
    }

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const) {
        process.on(signal, () => shutdown(0));
    }
    const crash = (err: unknown) => {
        try {
            stop();
        } catch {
            // Best effort
        }
        ui.restore();
        process.stderr.write(`debouncer crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
        process.exit(1);
    };
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);

    ui.start();
    try {
        await start(configPath, true);
    } catch (e) {
        shutdown(1, `debouncer: ${(e as Error).message}`);
    }
}

void main();
