import {existsSync, realpathSync} from "node:fs";
import {basename, dirname, isAbsolute, join, relative} from "node:path";

/**
 * True if `child` is `parent` itself or lies anywhere below it.
 * Unlike a plain `startsWith`, "/foo/barbaz" is not considered inside "/foo/bar".
 */
export function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * Resolves symlinks in `path` even if it does not exist yet, by resolving its deepest existing ancestor.
 * FSEvents always reports real paths (e.g. /private/tmp instead of /tmp), so every path we compare against
 * an event has to be resolved first.
 */
export function realpathLoose(path: string): string {
    if (existsSync(path)) {
        return realpathSync.native(path);
    }
    const parent = dirname(path);
    if (parent === path) {
        return path;
    }
    return join(realpathLoose(parent), basename(path));
}
