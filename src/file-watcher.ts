import { spawn } from "node:child_process";
import { platform, arch } from "node:process";
import path from "node:path";
import readline from "node:readline";

function getBinaryPath() {
    if (platform !== "darwin") {
        throw new Error("FSEvents watcher only works on macOS");
    }
    
    return path.join(
        __dirname,
        "..",
        "watcher/watcher"
    );
}

export enum WatchEventType {
    CREATE = "C",
    DELETE = "D",
    MODIFY = "M",
    RENAME = "R"
}

const WatchEventShortcuts: Map<string | null, WatchEventType | null> = new Map<string | null, WatchEventType | null>([
    ["C", WatchEventType.CREATE],
    ["D", WatchEventType.DELETE],
    ["M", WatchEventType.MODIFY],
    ["R", WatchEventType.RENAME]
])

export enum WatchFileType {
    DIRECTORY = "D",
    FILE = "F",
    SYMLINK = "S",
    HARDLINK = "H",
    LASTHARDLINK = "L",
}

const WatchFileShortcuts: Map<string | null, WatchFileType | null> = new Map<string | null, WatchFileType | null>([
    ["D", WatchFileType.DIRECTORY],
    ["F", WatchFileType.FILE],
    ["S", WatchFileType.SYMLINK],
    ["H", WatchFileType.HARDLINK],
    ["L", WatchFileType.LASTHARDLINK]
])

export interface WatcherInstance {
    close: () => void;
    listen: (callback: WatchCallback) => number;
    removeListener: (progressive: number) => boolean;
}

export type WatchCallback = (type: WatchEventType, fileType: WatchFileType, path: string, oldPath?: string) => void;

function splitEscaped(line: string, delim = "|") {
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


export function watch(dir: string, options?: {ignored?: string[], keepDSStore?: boolean}): Promise<WatcherInstance> {
    return new Promise<WatcherInstance>((resolve, reject) => {
        let args: string[] = [dir];
        
        if (options?.ignored != null) {
            args.push("--ignore", options.ignored.join(","));
        }
        
        const proc = spawn(getBinaryPath(), args, {
            stdio: ["ignore", "pipe", "inherit"]
        });
        
        const rl = readline.createInterface({
                                                input: proc.stdout
                                            });
        
        const callbacks: Map<number, WatchCallback> = new Map<number, WatchCallback>;
        
        let callbackProgressive = 0;
        
        rl.on("line", line => {
            if (line == "START") {
                resolve({
                            close() {
                                proc.kill();
                                rl.close();
                            },
                            listen(callback: WatchCallback): number {
                                let progressive = callbackProgressive++;
                                callbacks.set(progressive, callback);
                                return progressive;
                            },
                            removeListener(progressive: number): boolean {
                                if (callbacks.has(progressive)) {
                                    callbacks.delete(progressive);
                                    return true;
                                } else {
                                    return false
                                }
                            }
                        })
                return;
            }
            try {
                const pieces: string[] = splitEscaped(line);
                
                if ((pieces.length < 2) || ((pieces[0]?.length ?? 0) < 2)) {
                    return;
                }
                
                const flags                        = pieces[0] ?? "";
                const eventTypes: WatchEventType[] = [...flags].slice(0, -1)
                                                               .map(char => WatchEventShortcuts.get(char) ?? null)
                                                               .filter((e: WatchEventType | null): e is WatchEventType => e != null);
                
                const fileType: WatchFileType | null = WatchFileShortcuts.get(flags.charAt(flags.length - 1)) ?? null;
                if (fileType == null) {
                    return;
                }
                const firstFilename = pieces[1];
                if (firstFilename == null || firstFilename.length == 0) {
                    return;
                }
                const secondFilename = pieces[2];
                
                if (firstFilename.endsWith("/.DS_Store") && options?.keepDSStore != true) {
                    return;
                }
                
                for (let callback of callbacks.values()) {
                    for (const eventType of eventTypes) {
                        callback(eventType, fileType, path.normalize(firstFilename), secondFilename != null ? path.normalize(secondFilename) : undefined);
                    }
                }
            } catch {}
        });
        
        proc.on("error", (err) => {
            reject(err)
            console.log(err)
        })
        
        proc.on("exit", (code, signal) => {
            if (code != 0) {
                reject({code, signal});
            }
        });
    })
}
