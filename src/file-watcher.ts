import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {platform} from "node:process";
import path from "node:path";
import readline from "node:readline";

export const WATCHER_BINARY = path.join(__dirname, "..", "watcher", "watcher");

export enum WatchEventType {
    CREATE = "C",
    DELETE = "D",
    MODIFY = "M",
    RENAME = "R"
}

const WatchEventShortcuts = new Map<string, WatchEventType>([
    ["C", WatchEventType.CREATE],
    ["D", WatchEventType.DELETE],
    ["M", WatchEventType.MODIFY],
    ["R", WatchEventType.RENAME]
]);

export enum WatchFileType {
    DIRECTORY = "D",
    FILE = "F",
    SYMLINK = "S",
}

const WatchFileShortcuts = new Map<string, WatchFileType>([
    ["D", WatchFileType.DIRECTORY],
    ["F", WatchFileType.FILE],
    ["S", WatchFileType.SYMLINK]
]);

export interface WatcherInstance {
    close: () => void;
    listen: (callback: WatchCallback) => number;
    removeListener: (progressive: number) => boolean;
}

export type WatchCallback = (type: WatchEventType, fileType: WatchFileType, path: string, oldPath?: string) => void;

export interface WatchOptions {
    /** Paths whose events are never reported. */
    ignored?: string[];
    /** Subtrees where renames are detected; elsewhere a rename is reported as delete + create. Defaults to everything. */
    tracked?: string[];
    /** Report .DS_Store files too. */
    keepDSStore?: boolean;
    /** Called if the watcher process stops without close() being called. */
    onExit?: (reason: string) => void;
    /** Called when a listener throws. Defaults to console.error. */
    onError?: (error: unknown) => void;
}

export function splitEscaped(line: string, delim = "|") {
    const result = [];
    let current = "";
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (escaped) {
            current += ch;
            escaped = false;
        } else if (ch === "\\") {
            escaped = true;
        } else if (ch === delim) {
            result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }

    result.push(current);
    return result;
}

/** Parses one line of watcher output into its events, or returns null if the line is malformed. */
export function parseWatcherLine(line: string): { eventTypes: WatchEventType[], fileType: WatchFileType, path: string, oldPath?: string } | null {
    const pieces = splitEscaped(line);
    const flags  = pieces[0] ?? "";
    if (pieces.length < 2 || flags.length < 2) {
        return null;
    }

    const eventTypes = [...flags.slice(0, -1)]
        .map(char => WatchEventShortcuts.get(char))
        .filter((e): e is WatchEventType => e != null);
    const fileType   = WatchFileShortcuts.get(flags.charAt(flags.length - 1));
    const firstPath  = pieces[1];
    if (eventTypes.length == 0 || fileType == null || firstPath == null || firstPath.length == 0) {
        return null;
    }
    const secondPath = pieces[2];

    return {
        eventTypes,
        fileType,
        path:    path.normalize(firstPath),
        oldPath: secondPath != null && secondPath.length > 0 ? path.normalize(secondPath) : undefined
    };
}

export function watch(dir: string, options?: WatchOptions): Promise<WatcherInstance> {
    return new Promise<WatcherInstance>((resolve, reject) => {
        if (platform !== "darwin") {
            reject(new Error("The FSEvents watcher only works on macOS."));
            return;
        }
        if (!existsSync(WATCHER_BINARY)) {
            reject(new Error(`Watcher binary not found at ${WATCHER_BINARY}. Run "npm run build:watcher" to compile it.`));
            return;
        }

        const args: string[] = [dir];
        for (const ignored of options?.ignored ?? []) {
            args.push("--ignore", ignored);
        }
        for (const tracked of options?.tracked ?? []) {
            args.push("--track", tracked);
        }

        // stdin stays open as a lifeline: the watcher exits as soon as it is closed
        const proc = spawn(WATCHER_BINARY, args, {
            stdio: ["pipe", "pipe", "pipe"]
        });
        // Writing to a dead watcher's stdin raises EPIPE; exits are reported through "exit" instead
        proc.stdin.on("error", () => {});

        const rl = readline.createInterface({
            input: proc.stdout
        });

        const callbacks: Map<number, WatchCallback> = new Map<number, WatchCallback>();

        let callbackProgressive = 0;
        let started             = false;
        let closed              = false;
        let stderr              = "";

        proc.stderr.setEncoding("utf-8");
        proc.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-4000);
        });

        rl.on("line", line => {
            if (!started) {
                if (line == "START") {
                    started = true;
                    resolve({
                        close() {
                            closed = true;
                            rl.close();
                            proc.stdin.end();
                            proc.kill();
                        },
                        listen(callback: WatchCallback): number {
                            let progressive = callbackProgressive++;
                            callbacks.set(progressive, callback);
                            return progressive;
                        },
                        removeListener(progressive: number): boolean {
                            return callbacks.delete(progressive);
                        }
                    });
                }
                return;
            }

            const event = parseWatcherLine(line);
            if (event == null) {
                return;
            }
            if (path.basename(event.path) === ".DS_Store" && options?.keepDSStore != true) {
                return;
            }

            for (const callback of callbacks.values()) {
                for (const eventType of event.eventTypes) {
                    try {
                        callback(eventType, event.fileType, event.path, event.oldPath);
                    } catch (e) {
                        (options?.onError ?? console.error)(e);
                    }
                }
            }
        });

        proc.on("error", (err) => {
            if (!started) {
                reject(err);
            } else if (!closed) {
                options?.onExit?.(err.message);
            }
        });

        proc.on("exit", (code, signal) => {
            const details = stderr.trim();
            const reason  = `watcher exited with ${signal != null ? `signal ${signal}` : `code ${code}`}${details ? `: ${details}` : ""}`;
            if (!started) {
                reject(new Error(reason));
            } else if (!closed) {
                options?.onExit?.(reason);
            }
        });
    });
}
