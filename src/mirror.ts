import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, Stats, symlinkSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative} from "node:path";
import {Config} from "./config.js";
import {WatchEventType, WatchFileType} from "./file-watcher.js";
import {isInside} from "./paths.js";

export type LogType = "flush" | "edit" | "setup" | "delete" | "create" | "rename" | "error";

export type Logger = (message: string, type: LogType) => void;

/**
 * Removes a file, symlink or folder if it exists. Symlinks are removed themselves, never followed.
 * Unlike this, fs.rmSync with `force` silently skips dangling symlinks on recent Node versions.
 */
function removeEntry(path: string) {
    let stats: Stats;
    try {
        stats = lstatSync(path);
    } catch {
        return;
    }
    if (stats.isDirectory()) {
        rmSync(path, {recursive: true, force: true});
    } else {
        unlinkSync(path);
    }
}

/** A snapshot of a file taken when the change happened, applied to the output on flush. */
type Snapshot = { cachedFile: number } | { linkTarget: string };

export type PendingEvent =
    | { event: WatchEventType.CREATE, isDir: true, path: string }
    | { event: WatchEventType.CREATE | WatchEventType.MODIFY, isDir: false, path: string, snapshot: Snapshot }
    | { event: WatchEventType.RENAME, isDir: boolean, path: string, oldPath: string, snapshot?: Snapshot }
    | { event: WatchEventType.DELETE, isDir: boolean, path: string };

/**
 * Keeps the output folder in sync with the link folder:
 * - paths inside a watch entry are copied, and changes to them are queued until a flush;
 * - folders on the way to a watch entry are recreated as real folders;
 * - everything else is symlinked, so it is always live.
 */
export class Mirror {
    readonly pending: PendingEvent[] = [];
    lastChanged: Date | null         = null;
    lastFlushed: Date | null         = null;
    flushing                         = false;
    /** Called when a commit trigger changes. */
    onTrigger: ((path: string) => void) | null = null;

    private readonly cacheDir: string;
    private cacheProgressive = 0;
    /** True once the output folder is ours to delete. */
    private outputOwned      = false;

    constructor(readonly config: Config, private readonly log: Logger) {
        this.cacheDir = mkdtempSync(join(tmpdir(), "folder-debouncer-"));
    }

    // --- Path classification ---

    rel(path: string): string {
        return relative(this.config.linkFolder, path) || ".";
    }

    toDest(path: string): string {
        return join(this.config.outputFolder, relative(this.config.linkFolder, path));
    }

    isIgnored(path: string): boolean {
        return this.config.ignore.some(ignored => isInside(path, ignored));
    }

    isWatched(path: string): boolean {
        return this.config.watch.some(watched => isInside(path, watched));
    }

    isTrigger(path: string): boolean {
        return this.config.commitTriggers.includes(path);
    }

    /** True if `dir` is a strict ancestor of a watch entry, so it is a real folder in the output. */
    containsWatched(dir: string): boolean {
        return this.config.watch.some(watched => watched !== dir && isInside(watched, dir));
    }

    /** True if `dir` exists as a real folder in the output (as opposed to living inside a symlinked folder). */
    isRealInOutput(dir: string): boolean {
        return dir === this.config.linkFolder || this.isWatched(dir) || this.containsWatched(dir);
    }

    // --- Setup / teardown ---

    /**
     * Makes sure the output folder exists and is empty. Asks before deleting anything.
     * Returns false if the user refused.
     */
    async prepareOutput(confirm: (question: string) => Promise<boolean>): Promise<boolean> {
        const output = this.config.outputFolder;
        if (existsSync(output)) {
            let empty = false;
            try {
                empty = readdirSync(output).length === 0;
            } catch {
                // Not a directory
            }
            if (!empty) {
                if (!await confirm(`Output folder "${output}" is not empty. Delete its contents? (y/N)`)) {
                    return false;
                }
                this.log(`Deleting contents of output folder: ${output}`, "setup");
                removeEntry(output);
            }
        }
        if (!existsSync(output)) {
            this.log(`Creating output folder: ${output}`, "setup");
            mkdirSync(output, {recursive: true});
        }
        this.outputOwned = true;
        return true;
    }

    /** Populates the output folder from scratch. */
    initialMirror() {
        const counts = {copied: 0, linked: 0};
        for (const entry of readdirSync(this.config.linkFolder)) {
            const src = join(this.config.linkFolder, entry);
            this.mirrorEntry(src, this.toDest(src), counts);
        }
        this.log(`Mirrored ${this.config.linkFolder}: ${counts.copied} copied, ${counts.linked} symlinked.`, "setup");
        this.lastFlushed = new Date();
    }

    /** Removes the cache folder and, if we created or emptied it, the output folder. */
    dispose() {
        rmSync(this.cacheDir, {recursive: true, force: true});
        if (this.outputOwned) {
            removeEntry(this.config.outputFolder);
            this.outputOwned = false;
        }
    }

    // --- Events ---

    handleEvent(eventType: WatchEventType, fileType: WatchFileType, path: string, oldPath?: string) {
        if (path === this.config.linkFolder) {
            return;
        }
        const isDir = fileType == WatchFileType.DIRECTORY;

        try {
            if (eventType == WatchEventType.RENAME && oldPath != null) {
                const oldIgnored = this.isIgnored(oldPath);
                const newIgnored = this.isIgnored(path);
                if (oldIgnored && newIgnored) {
                    return;
                }
                this.lastChanged = new Date();
                if (!oldIgnored && !newIgnored && this.isWatched(oldPath) && this.isWatched(path)) {
                    this.pending.push({
                        event:    WatchEventType.RENAME,
                        isDir,
                        path,
                        oldPath,
                        snapshot: isDir ? undefined : this.snapshot(path) ?? undefined
                    });
                    this.log(`${this.rel(oldPath)} ⇋ ${this.rel(path)}`, "rename");
                } else {
                    // Crossing the watched/unwatched boundary: treat as removal plus addition
                    if (!oldIgnored) {
                        this.removed(oldPath, isDir);
                    }
                    if (!newIgnored) {
                        this.added(path, isDir);
                    }
                }
            } else {
                if (this.isIgnored(path)) {
                    return;
                }
                this.lastChanged = new Date();
                if (eventType == WatchEventType.CREATE || eventType == WatchEventType.RENAME) {
                    this.added(path, isDir);
                } else if (eventType == WatchEventType.MODIFY) {
                    this.modified(path, isDir);
                } else if (eventType == WatchEventType.DELETE) {
                    this.removed(path, isDir);
                }
            }
        } catch (e) {
            this.log(`Could not handle change to ${this.rel(path)}: ${(e as Error).message}`, "error");
        }

        if (this.isTrigger(path)) {
            this.log(`Commit trigger: ${this.rel(path)}`, "flush");
            this.onTrigger?.(path);
        }
    }

    private added(path: string, isDir: boolean) {
        if (this.isWatched(path)) {
            if (isDir) {
                this.pending.push({event: WatchEventType.CREATE, isDir: true, path});
            } else {
                const snapshot = this.snapshot(path);
                if (snapshot == null) {
                    // Already gone again; its deletion event will follow
                    return;
                }
                this.pending.push({event: WatchEventType.CREATE, isDir: false, path, snapshot});
            }
            this.log(this.rel(path), "create");
        } else if (this.isRealInOutput(dirname(path))) {
            this.mirrorEntry(path, this.toDest(path));
            this.log(`Linked ${this.rel(path)}`, "create");
        }
        // Otherwise it is inside a symlinked folder and already visible in the output
    }

    private modified(path: string, isDir: boolean) {
        // Directory metadata changes are not mirrored; unwatched files are symlinks and always live
        if (isDir || !this.isWatched(path)) {
            return;
        }
        const snapshot = this.snapshot(path);
        if (snapshot == null) {
            return;
        }
        this.pending.push({event: WatchEventType.MODIFY, isDir: false, path, snapshot});
        this.log(this.rel(path), "edit");
    }

    private removed(path: string, isDir: boolean) {
        if (this.isWatched(path)) {
            this.pending.push({event: WatchEventType.DELETE, isDir, path});
            this.log(this.rel(path), "delete");
        } else if (this.isRealInOutput(dirname(path))) {
            const dest = this.toDest(path);
            if (this.lexists(dest)) {
                this.assertSafeDest(dest);
                removeEntry(dest);
                this.log(`Unlinked ${this.rel(path)}`, "delete");
            }
        }
    }

    /** Copies the current state of a file into the cache, or null if it no longer exists. */
    private snapshot(path: string): Snapshot | null {
        let stats: Stats;
        try {
            stats = lstatSync(path);
            if (stats.isSymbolicLink()) {
                return {linkTarget: readlinkSync(path)};
            }
            const cachedFile = this.cacheProgressive++;
            copyFileSync(path, join(this.cacheDir, String(cachedFile)));
            return {cachedFile};
        } catch {
            return null;
        }
    }

    // --- Flush ---

    /** Applies every pending change to the output folder. */
    flush() {
        if (this.flushing) {
            return;
        }
        this.flushing = true;
        try {
            const events = this.pending.splice(0, Infinity);
            for (const event of events) {
                try {
                    this.apply(event);
                } catch (e) {
                    this.log(`Could not apply change to ${this.rel(event.path)}: ${(e as Error).message}`, "error");
                }
            }
            rmSync(this.cacheDir, {recursive: true, force: true});
            mkdirSync(this.cacheDir, {recursive: true});
            this.lastFlushed = new Date();
        } finally {
            this.flushing = false;
        }
    }

    private apply(event: PendingEvent) {
        const rel  = this.rel(event.path);
        const dest = this.toDest(event.path);
        const kind = event.isDir ? "directory" : "file";
        this.assertSafeDest(dest);

        switch (event.event) {
            case WatchEventType.DELETE:
                removeEntry(dest);
                this.log(`Removed ${kind} ${rel}`, "flush");
                break;
            case WatchEventType.RENAME: {
                const destOld = this.toDest(event.oldPath);
                this.assertSafeDest(destOld);
                if (event.snapshot != null) {
                    removeEntry(destOld);
                    this.writeSnapshot(event.snapshot, dest);
                } else if (this.lexists(destOld)) {
                    removeEntry(dest);
                    mkdirSync(dirname(dest), {recursive: true});
                    renameSync(destOld, dest);
                } else if (existsSync(event.path)) {
                    this.mirrorEntry(event.path, dest);
                }
                this.log(`Moved ${kind} ${this.rel(event.oldPath)} to ${rel}`, "flush");
                break;
            }
            case WatchEventType.CREATE:
                if (event.isDir) {
                    // A folder moved in from elsewhere comes with contents that get no events of their own
                    if (existsSync(event.path)) {
                        this.mirrorEntry(event.path, dest);
                    } else {
                        mkdirSync(dest, {recursive: true});
                    }
                } else {
                    this.writeSnapshot(event.snapshot, dest);
                }
                this.log(`Created ${kind} ${rel}`, "flush");
                break;
            case WatchEventType.MODIFY:
                this.writeSnapshot(event.snapshot, dest);
                this.log(`Updated file ${rel}`, "flush");
                break;
        }
    }

    private writeSnapshot(snapshot: Snapshot, dest: string) {
        mkdirSync(dirname(dest), {recursive: true});
        // Never write through an existing symlink: it would modify the source
        this.removeUnlessFile(dest);
        if ("linkTarget" in snapshot) {
            removeEntry(dest);
            symlinkSync(snapshot.linkTarget, dest);
        } else {
            copyFileSync(join(this.cacheDir, String(snapshot.cachedFile)), dest);
        }
    }

    // --- Mirroring ---

    /** Recreates `src` at `dest`: real folders and copies where watched, symlinks elsewhere. */
    private mirrorEntry(src: string, dest: string, counts = {copied: 0, linked: 0}) {
        if (this.isIgnored(src)) {
            return;
        }
        let stats: Stats;
        try {
            stats = lstatSync(src);
        } catch {
            return;
        }

        if (stats.isDirectory() && (this.isWatched(src) || this.containsWatched(src))) {
            if (this.lexists(dest) && !lstatSync(dest).isDirectory()) {
                removeEntry(dest);
            }
            mkdirSync(dest, {recursive: true});
            for (const entry of readdirSync(src)) {
                this.mirrorEntry(join(src, entry), join(dest, entry), counts);
            }
            return;
        }

        removeEntry(dest);
        if (!this.isWatched(src)) {
            symlinkSync(src, dest);
            counts.linked++;
        } else if (stats.isSymbolicLink()) {
            symlinkSync(readlinkSync(src), dest);
            counts.copied++;
        } else if (stats.isFile()) {
            copyFileSync(src, dest);
            counts.copied++;
        }
        // Sockets, FIFOs and devices are skipped
    }

    // --- Helpers ---

    private lexists(path: string): boolean {
        try {
            lstatSync(path);
            return true;
        } catch {
            return false;
        }
    }

    private removeUnlessFile(path: string) {
        try {
            if (!lstatSync(path).isFile()) {
                removeEntry(path);
            }
        } catch {
            // Does not exist
        }
    }

    /**
     * Guards against writing into the sources: every folder between the output root and `dest` must be a real
     * folder, not a symlink pointing back into the link folder.
     */
    private assertSafeDest(dest: string) {
        const output = this.config.outputFolder;
        if (!isInside(dest, output) || dest === output) {
            throw new Error(`Refusing to touch ${dest}: outside the output folder`);
        }
        for (let dir = dirname(dest); dir !== output && isInside(dir, output); dir = dirname(dir)) {
            try {
                if (lstatSync(dir).isSymbolicLink()) {
                    throw new Error(`Refusing to write through symlinked folder ${dir}`);
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw e;
                }
            }
        }
    }
}
