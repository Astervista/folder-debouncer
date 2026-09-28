import {Config, ConfigJSON} from "./classes.js";
import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rename, renameSync, rmSync, statSync, symlinkSync} from "graceful-fs";
import {dirname, join, relative} from "path";
import {createInterface} from "readline";
import {EventEmitter} from "events";
import {watch, WatcherInstance, WatchEventType, WatchFileType} from "./file-watcher.js";

let configFile: ConfigJSON = JSON.parse(readFileSync("debouncer.json", "utf-8"));

if (!configFile.linkFolder.startsWith("/")) {
    configFile.linkFolder = join(process.cwd(), configFile.linkFolder);
}

if (!configFile.outputFolder.startsWith("/")) {
    configFile.outputFolder = join(process.cwd(), configFile.outputFolder);
}

function adjustValue(value: undefined | string | string[]): string[] {
    value = value instanceof Array ? value : (value == null ? [] : [value]);
    value = value.map(path => {
        if (!path.startsWith("/")) {
            path = join(configFile.linkFolder, path);
        }
        return path;
    });
    return value;
}

configFile.watch          = adjustValue(configFile.watch);
configFile.ignore         = adjustValue(configFile.ignore);
configFile.commitTriggers = adjustValue(configFile.commitTriggers);

let config: Config = {
    linkFolder:     configFile.linkFolder,
    outputFolder:   configFile.outputFolder,
    watch:          configFile.watch,
    ignore:         configFile.ignore,
    commitTriggers: configFile.commitTriggers
};

if (!config.watch.every(f => f.startsWith(config.linkFolder))) {
    console.error("All watch folders must be within the link folder.");
}

if (!config.commitTriggers.every(f => f.startsWith(config.linkFolder))) {
    console.error("All commit triggers must be within the link folder.");
}

if (!config.ignore.every(f => f.startsWith(config.linkFolder))) {
    console.error("All ignore paths must be within the link folder.");
}

if (config.outputFolder.startsWith(config.linkFolder)) {
    console.error("Output folder must not be within the link folder.");
}

let columns = process.stdout.columns ?? 80;
let rows    = process.stdout.rows ?? 24;

const fixedDifference = 5;

const backScroll: string[]                                                                                             = [];
const backScrollRaw: { text: string, type: "flush" | "edit" | "setup" | "delete" | "create" | "rename", date: Date }[] = [];
let scrollTop                                                                                                          = 0;

let lastMouseCommand: string | null = null;

function clearAnsiEscape(str: string): string {
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function writeLineWithDateType(message: string, type: "flush" | "edit" | "setup" | "delete" | "create" | "rename", date: Date = new Date()) {
    backScrollRaw.push({
                           text: message,
                           type,
                           date
                       });
    const dateString           = date.toLocaleTimeString();
    let lines                  = message.split("\n");
    let wrappedLines: string[] = [];
    lines.forEach(line => {
        for (let i = 0; i < line.length; i += columns - dateString.length - fixedDifference) {
            wrappedLines.push(line.slice(i, i + columns - dateString.length - fixedDifference));
        }
    });
    if ((backScroll.length >= rows - 2) && (scrollTop > 0)) {
        let missing: string[];
        if (scrollTop < rows) {
            process.stdout.write(`\x1B[${scrollTop}S`); // Scroll up
            missing = backScroll.slice(-scrollTop);
        } else {
            process.stdout.write(`\x1Bc"`); // Clear screen
            missing = backScroll.slice(-rows + 2);
        }
        process.stdout.write(`\x1B[${rows - 2 - scrollTop};1H`); // Move to bottom-
        missing.forEach((line) => process.stdout.write(line + "\n"));
    }
    let firstRow: string = "";
    switch (type) {
        case "flush":
            firstRow = `\x1B[38;5;36m ▼\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
        case "edit":
            firstRow = `\x1B[38;5;208m✏︎\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
        case "setup":
            firstRow = `\x1B[38;5;45m⚙︎\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
        case "delete":
            firstRow = `\x1B[38;5;197m✖︎\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
        case "create":
            firstRow = `\x1B[38;5;42m✶︎\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
        case "rename":
            firstRow = `\x1B[38;5;208m⇋\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0]}`;
            break;
    }
    process.stdout.write(`${firstRow}\n`);
    backScroll.push(firstRow);
    wrappedLines.slice(1).forEach(item => {
        let printLine = `${
            new Array(dateString.length + fixedDifference).fill(" ").join("")
        }${item}`;
        backScroll.push(printLine);
        process.stdout.write(`${printLine}\n`);
    });
    scrollTop = 0;
}

function folderWithTrailingSlash(folder: string): string {
    return folder.endsWith("/") ? folder : folder + "/";
}

function folderWithoutTrailingSlash(folder: string): string {
    return folder.endsWith("/") ? folder.slice(0, -1) : folder;
}

function getContainingFolder(path: string): string {
    let folderWithoutSlash = folderWithoutTrailingSlash(path);
    return folderWithTrailingSlash(folderWithoutSlash.slice(0, folderWithoutSlash.lastIndexOf("/")));
}

// Every folder should have a trailing slash
config.linkFolder   = folderWithTrailingSlash(config.linkFolder);
config.outputFolder = folderWithTrailingSlash(config.outputFolder);
config.watch        = config.watch.map(path => {
    if (lstatSync(path).isDirectory()) {
        return folderWithTrailingSlash(path);
    }
    return path;
});

// Ignored should never have a trailing slash
config.ignore = config.ignore.map(path => folderWithoutTrailingSlash(path));

const ignored: { path: string, isDir: boolean }[] = config.ignore.map(path => {
    let info = statSync(path);
    return {
        path,
        isDir: info.isDirectory()
    };
});

const tempName = `/tmp/folder-debouncer/cache/${String.fromCharCode(...new Array(15).fill("a".charCodeAt(0)).map(e => Math.floor(Math.random() * 26) + e))}/`;

let tempFileProgressive: number = 0;

const watchParents: string[] = config.watch.map(getContainingFolder);

// --- Output folder check/creation/deletion ---
function isDirEmpty(path: string) {
    return !existsSync(path) || readdirSync(path).length === 0;
}

function prompt(question: string): Promise<boolean> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase().startsWith("y"));
        });
    });
}

let cleanFolderRequestCallback: ((result: boolean) => void) | null = null;

async function ensureCleanOutputFolder() {
    if (existsSync(config.outputFolder)) {
        if (!isDirEmpty(config.outputFolder)) {
            let promise = new Promise<boolean>((resolve) => {
                cleanFolderRequestCallback = resolve;
            });
            resetUI();
            writeLineWithDateType(`Output folder "${config.outputFolder}" is not empty. Delete contents? (Y/N)`, "setup");
            const confirmed            = await promise;
            cleanFolderRequestCallback = null;
            if (!confirmed) {
                console.error("Aborted by user.");
                process.exit(1);
            }
            writeLineWithDateType(`Deleting contents of output folder: ${config.outputFolder}`, "setup");
            rmSync(config.outputFolder, {recursive: true, force: true});
        }
    }
    if (!existsSync(config.outputFolder)) {
        writeLineWithDateType(`Creating output folder: ${config.outputFolder}`, "setup");
        mkdirSync(config.outputFolder, {recursive: true});
    }
}

// --- Copy/symlink logic ---
function isInWatchFolders(absPath: string): boolean {
    return config.watch.filter(path => path.endsWith("/")).some(watchFolder => absPath === watchFolder || absPath.startsWith(watchFolder));
}

function isInCommitTriggers(absPath: string): boolean {
    return config.commitTriggers.some(trigger => absPath === trigger);
}

function copyOrSymlinkRecursive(src: string, dest: string) {
    if (!existsSync(src)) {
        return;
    }
    const stats = lstatSync(src);
    if (config.ignore.includes(folderWithoutTrailingSlash(src))) {
        return;
    }
    if (stats.isDirectory()) {
        // Check if this folder contains watch paths
        if (config.watch.some(watchFolder => src === watchFolder || watchFolder.startsWith(folderWithTrailingSlash(src))) || isInWatchFolders(src)) {
            if (!existsSync(dest)) {
                writeLineWithDateType(`Creating directory: ${dest}`, "setup");
                mkdirSync(dest, {recursive: true});
            }
            for (const entry of readdirSync(src)) {
                copyOrSymlinkRecursive(join(src, entry), join(dest, entry));
            }
        } else {
            // This directory is not a watch folder, so we symlink it
            try {
                symlinkSync(src, dest);
                writeLineWithDateType(`Symlinked directory: ${src} -> ${dest}`, "setup");
            } catch (e) {
                // If symlink exists, replace
                if (existsSync(dest)) {
                    rmSync(dest);
                }
                symlinkSync(src, dest);
                writeLineWithDateType(`Re-symlinked directory: ${src} -> ${dest}`, "setup");
            }
        }
    } else if (stats.isFile()) {
        if (isInWatchFolders(src) || config.watch.includes(src)) {
            // Copy file
            mkdirSync(dirname(dest), {recursive: true});
            copyFileSync(src, dest);
            writeLineWithDateType(`Copied file: ${src} -> ${dest}`, "setup");
        } else {
            // Symlink file
            mkdirSync(dirname(dest), {recursive: true});
            try {
                symlinkSync(src, dest);
                writeLineWithDateType(`Symlinked file: ${src} -> ${dest}`, "setup");
            } catch (e) {
                // If symlink exists, replace
                if (existsSync(dest)) {
                    rmSync(dest);
                }
                symlinkSync(src, dest);
                writeLineWithDateType(`Re-symlinked file: ${src} -> ${dest}`, "setup");
            }
        }
    }
}

// --- Watch logic ---
const eventsToFlush: ({
    event: WatchEventType.DELETE,
    fileType: WatchFileType,
    path: string,
} | {
    event: WatchEventType.CREATE,
    fileType: WatchFileType.DIRECTORY,
    path: string,
} | {
    event: WatchEventType.MODIFY | WatchEventType.CREATE,
    fileType: WatchFileType.FILE,
    cachedFile: number,
    path: string,
} | {
    event: WatchEventType.RENAME,
    fileType: WatchFileType,
    path: string,
    oldPath: string,
})[]                         = [];
let flushing: boolean        = false;
let lastChanged: Date | null = null;
let lastFlushed: Date | null = null;
let emitter                  = new EventEmitter();

function removeOutputFor(absPath: string) {
    const rel  = relative(config.linkFolder, absPath);
    const dest = join(config.outputFolder, rel);
    if (existsSync(dest)) {
        const stats = lstatSync(dest);
        if (stats.isDirectory()) {
            rmSync(dest, {recursive: true, force: true});
            writeLineWithDateType(`Removed directory from output: ${dest}`, "delete");
        } else {
            rmSync(dest, {force: true});
            writeLineWithDateType(`Removed file/symlink from output: ${dest}`, "delete");
        }
    }
}

function flushTouchedFiles() {
    for (const event of eventsToFlush) {
        const rel  = relative(config.linkFolder, event.path);
        const dest = join(config.outputFolder, rel);
        if (event.event == WatchEventType.DELETE) {
            rmSync(dest, {recursive: true, force: true});
            writeLineWithDateType(`Removed ${event.fileType == WatchFileType.FILE ? "file" : "directory"} ${rel}`, "setup");
        } else if (event.event == WatchEventType.RENAME) {
            const relOld  = relative(config.linkFolder, event.oldPath);
            const destOld = join(config.outputFolder, relOld);
            renameSync(destOld, dest);
            writeLineWithDateType(`Moved ${event.fileType == WatchFileType.FILE ? "file" : "directory"} ${relOld} to ${rel}`, "setup");
        } else if (event.event == WatchEventType.CREATE) {
            if (event.fileType == WatchFileType.DIRECTORY) {
                mkdirSync(dest, {recursive: true});
            } else {
                copyFileSync(tempName + event.cachedFile, dest);
            }
            writeLineWithDateType(`Created ${event.fileType == WatchFileType.FILE ? "file" : "directory"} ${rel}`, "setup");
        } else if (event.event == WatchEventType.MODIFY) {
            copyFileSync(tempName + event.cachedFile, dest);
            writeLineWithDateType(`Modified file ${rel}`, "setup");
        }
    }
    lastFlushed = new Date();
    eventsToFlush.splice(0, Infinity);
    rmSync(tempName, {recursive: true, force: true});
    mkdirSync(tempName, {recursive: true});
    writeUI();
}

function handleSymlinkAddition(absPath: string) {
    const rel  = relative(config.linkFolder, absPath);
    const dest = join(config.outputFolder, rel);
    try {
        symlinkSync(absPath, dest);
        writeLineWithDateType(`Symlinked file: ${absPath} -> ${dest}`, "setup");
    } catch (e) {
        if (existsSync(dest)) {
            rmSync(dest);
        }
        symlinkSync(absPath, dest);
        writeLineWithDateType(`Re-symlinked file: ${absPath} -> ${dest}`, "setup");
    }
}

function handleSymlinkRemoval(absPath: string) {
    removeOutputFor(absPath);
}

function needsToBeIgnored(absPath: string, isDir: boolean): boolean {
    if (isDir) {
        let absPathWithTrailingSlash = folderWithTrailingSlash(absPath);
        return ignored.some(ignoredElement => ignoredElement.isDir && absPathWithTrailingSlash.startsWith(folderWithTrailingSlash(ignoredElement.path)));
    } else {
        return ignored.some(ignoredElement => {
            if (ignoredElement.isDir) {
                return absPath.startsWith(folderWithTrailingSlash(ignoredElement.path));
            } else {
                return absPath === ignoredElement.path;
            }
        });
    }
}

let watcher: WatcherInstance;

async function watchEverything(folder: string) {
    if (!existsSync(folder)) {
        return;
    }
    if (config.ignore.includes(folderWithoutTrailingSlash(folder))) {
        writeLineWithDateType(`Ignoring symlink folder: ${folder}`, "setup");
        return;
    }
    
    writeLineWithDateType("Setting up watch for main folder: " + folder, "setup");
    watcher = await watch(
        folder,
        {
            ignored: ignored
                         .filter(file => file.isDir)
                         .map(dir => dir.path)
        }
    );
    writeLineWithDateType("Watch started.", "setup");
    watcher.listen((eventType, fileType, filename, oldFilename) => {
        if (!filename) {
            return;
        }
        lastChanged = new Date();
        if (needsToBeIgnored(filename, fileType == WatchFileType.DIRECTORY)) {
            writeLineWithDateType(`Ignoring ${filename}`, "edit");
            return;
        }
        
        // If this is inside a watch folder, record the change for commit
        // TODO: Handle symlinks
        if (isInWatchFolders(filename) || config.watch.includes(filename)) {
            
            if (eventType == WatchEventType.CREATE) {
                if (fileType == WatchFileType.FILE) {
                    let cachedFileId = tempFileProgressive++;
                    copyFileSync(filename, tempName + cachedFileId);
                    eventsToFlush.push({
                                           event:      WatchEventType.CREATE,
                                           fileType:   fileType,
                                           cachedFile: cachedFileId,
                                           path:       filename
                                       });
                } else if (fileType == WatchFileType.DIRECTORY) {
                    eventsToFlush.push({
                                           event:    WatchEventType.CREATE,
                                           fileType: fileType,
                                           path:     filename
                                       });
                }
                writeLineWithDateType(filename, "create");
            } else if (eventType == WatchEventType.MODIFY) {
                if (fileType == WatchFileType.FILE) {
                    let cachedFileId = tempFileProgressive++;
                    copyFileSync(filename, tempName + cachedFileId);
                    eventsToFlush.push({
                                           event:      WatchEventType.MODIFY,
                                           fileType:   fileType,
                                           cachedFile: cachedFileId,
                                           path:       filename
                                       }
                    );
                }
                // TODO: Directory modify is not handled because we still don't handle metadata changes, but may be a good idea to handle them
                writeLineWithDateType(filename, "edit");
            } else if (eventType == WatchEventType.RENAME) {
                if (fileType == WatchFileType.FILE || fileType == WatchFileType.DIRECTORY) {
                    if (oldFilename) {
                        eventsToFlush.push({
                                               event:    WatchEventType.RENAME,
                                               fileType: fileType,
                                               path:     filename,
                                               oldPath:  oldFilename
                                           });
                    }
                }
                writeLineWithDateType(oldFilename + " ⇋ " + filename, "rename");
            } else if (eventType == WatchEventType.DELETE) {
                if (fileType == WatchFileType.FILE || fileType == WatchFileType.DIRECTORY) {
                    eventsToFlush.push({
                                           event:    WatchEventType.DELETE,
                                           fileType: fileType,
                                           path:     filename
                                       });
                }
                writeLineWithDateType(filename, "delete");
            }
            if (isInCommitTriggers(filename)) {
                writeLineWithDateType(`Commit trigger: ${filename}`, "flush");
                emitter.emit("commit");
            }
            return;
        }
        
        // In order to handle the file, we have to know if its counterpart is in an already symlinked folder, or
        // if we need to create a new symlink. This is because the highest folder not containing a watch folder
        // already has a symlink, if this is child of that folder, it is already handled by the parent folder
        // TODO: edge cases and handle folder renaming/moving
        if (fileType == WatchFileType.DIRECTORY) {
            let directoryWithTrailingSlash = folderWithTrailingSlash(filename);
            if (watchParents.some(path => path.startsWith(directoryWithTrailingSlash))) {
                // This is a parent of a watch folder, so we need to handle it as a folder
                if (eventType === WatchEventType.CREATE || eventType === WatchEventType.MODIFY) {
                    if (!existsSync(filename)) {
                        mkdirSync(filename);
                    }
                } else if (eventType == WatchEventType.DELETE) {
                    rmSync(filename);
                }
            } else {
                let parentFolder = getContainingFolder(filename);
                if (watchParents.some(path => path.startsWith(parentFolder))) {
                    // This is a symlinked directory, so we need to handle it
                    if (eventType === WatchEventType.CREATE) {
                        writeLineWithDateType(`Symlinked directory ${filename}`, "edit");
                        handleSymlinkAddition(filename);
                    } else if (eventType == WatchEventType.DELETE) {
                        writeLineWithDateType(`Symlinked directory ${filename}`, "delete");
                        handleSymlinkRemoval(filename);
                    }
                }
            }
        } else {
            // Symlink only if a sibling of a parent of a watch folder
            let parentFolder = getContainingFolder(filename);
            if (watchParents.some(path => path.startsWith(parentFolder))) {
                // This is a symlinked file, so we need to handle it
                if (eventType === WatchEventType.CREATE ) {
                    writeLineWithDateType(`Symlinked file ${filename}`, "edit");
                    handleSymlinkAddition(filename);
                } else if (eventType == WatchEventType.DELETE) {
                    writeLineWithDateType(`Symlinked file ${filename}`, "delete");
                    handleSymlinkRemoval(filename);
                }
            }
        }
        if (uiWritten) {
            uiWritten = false;
            setTimeout(writeUI, 0);
        }
    });
}

let uiWritten = true;

function writeUI() {
    uiWritten = true;
    process.stdout.write(`\x1B7`); // Save cursor position
    process.stdout.write("\x1B[r"); // Reset region
    process.stdout.write(`\x1B[1;1H`); // Move to top-left
    process.stdout.write(`\x1B[2K`); // Clear line
    process.stdout.write("\x1B[22m"); // Bold text
    process.stdout.write("\x1B[39m"); // White text
    process.stdout.write("Angular Debouncer is running. Press Ctrl+C to exit. Press H for help.");
    const legend = "Legend:  \x1B[38;5;197m✖︎ Deleted  \x1B[38;5;208m✏︎ Modified  \x1B[38;5;36m ▼ Flushed  \x1B[38;5;45m⚙︎ Setup\x1B[0m";
    process.stdout.write(`\x1B[1;${columns - clearAnsiEscape(legend).length}H`); // Move to top-right
    process.stdout.write(legend);
    process.stdout.write("\x1B[0m"); // Reset text
    process.stdout.write(`\x1B[${rows};1H`); // Move to last line
    process.stdout.write(`\x1B[2K`); // Clear line
    process.stdout.write("Status: ");
    process.stdout.write("\x1B[22m"); // Bold text
    if (flushing) {
        process.stdout.write("\x1B[38;5;197m"); // Red text
        process.stdout.write("● Flushing changes...");
    } else if (eventsToFlush.length == 0) {
        process.stdout.write("\x1B[38;5;78m"); // Green text
        process.stdout.write("● No changes");
    } else {
        process.stdout.write("\x1B[38;5;208m"); // Orange text
        process.stdout.write(`● Changes pending`);
    }
    process.stdout.write("\x1B[0m"); // Reset text
    
    const deletedFiles  = eventsToFlush.filter(event => event.event == WatchEventType.DELETE);
    const renamedFiles  = eventsToFlush.filter(event => event.event == WatchEventType.RENAME);
    const createdFiles  = eventsToFlush.filter(event => event.event == WatchEventType.CREATE);
    const modifiedFiles = eventsToFlush.filter(event => event.event == WatchEventType.MODIFY);
    
    const deletedString     = deletedFiles.length > 0 ? `\x1B[38;5;197m✖︎ ${deletedFiles.length}\x1B[0m` : "";
    const renamedString     = renamedFiles.length > 0 ? `\x1B[38;5;197m⇋ ${renamedFiles.length}\x1B[0m` : "";
    const createdString     = createdFiles.length > 0 ? `\x1B[38;5;197m✶︎ ${createdFiles.length}\x1B[0m` : "";
    const modifiedString    = modifiedFiles.length > 0 ? `\x1B[38;5;197m✏︎ ${modifiedFiles.length}\x1B[0m` : "";
    const lastFlushedString = lastFlushed == null ? "" : `\x1B[38;5;36m▼ ${lastFlushed.toLocaleTimeString()}\x1B[0m`;
    const lastChangedString = lastChanged == null ? "" : `\x1B[38;5;208m✏︎✖︎ ${lastChanged.toLocaleTimeString()}\x1B[0m`;
    
    let infoString = [createdString, renamedString, modifiedString, deletedString].filter(s => s !== "").join(" | ");
    let timeString = [lastChangedString, lastFlushedString].filter(s => s !== "").join(" - ");
    if (timeString.length > 0) {
        timeString = "⏲: " + timeString;
    }
    const fullString = [infoString, timeString].filter(s => s !== "").join(" | ");
    process.stdout.write(`\x1B[${rows};${columns - clearAnsiEscape(fullString).length}H`); // Move to bottom-right
    process.stdout.write(fullString);
    process.stdout.write(`\x1B[2;${rows - 1}r`); // Create central region
    process.stdout.write(`\x1B[2;1H`); // Move to top-left of region
    process.stdout.write(`\x1B8`); // Restore cursor position
    process.stdout.write("\x1B[0m"); // Reset text
    process.stdout.write("\x1B[38;5;244m"); // Gray text
    process.stdout.write(`\x1B[?25l`); // Hide cursor
}

function setupScreen() {
    process.stdout.write("\x1Bc"); // Clear screen
    process.stdout.write(`\x1B[2;1H`); // Move to top-left of region
    process.stdout.write(`\x1B[?25l`); // Hide cursor
    process.stdout.write("\x1b[?1003h"); // Enable mouse move events
    
    process.stdin.setRawMode(true);
    process.stdin.resume();
    
    writeUI();
}

function resetUI() {
    setupScreen();
    for (const line of backScrollRaw.slice(-rows)) {
        writeLineWithDateType(line.text, line.type, line.date);
    }
}

let currentScreen = "main";

const helpLines = [
    "This tool allows you to watch a folder and its subfolders for changes, and copy the changes to an output folder. The changes are not mirrored in real-time, but are debounced and " +
    "flushed when a commit trigger file is changed, or when the user forces a flush.",
    "",
    "At any point, you can press one of thede following keys to perform an action:",
    "",
    "   X, ^c: Exit from the program",
    "       F: Force flush of all changes",
    "       R: Restart the debouncer",
    " Up/Down: Scroll the log",
    "       H: Show this help",
    "",
    "Press any key to return to the main screen."
];

const helpTitle = "\x1B[1m\x1B[38;5;75mAngular Debouncer\x1B[22m - Help\x1B[0m";

let main = async () => {
    setupScreen();
    
    let onKey = (chunk: Buffer) => {
        let key = chunk.toString();
        
        if (cleanFolderRequestCallback != null) {
            if (key == "y" || key == "Y") {
                cleanFolderRequestCallback(true);
            }
            if (key == "n" || key == "N") {
                cleanFolderRequestCallback(true);
            }
            return;
        }
        // Handle mouse events
        if (key.startsWith("\x1b[M")) {
            /*
             LEGEND:
             `ESC[M#${asciiX}${asciiY}`: mouseMove or mouseUp if dragging or down
             `ESC[M ${asciiX}${asciiY}`: mouseDown
             `ESC[M@${asciiX}${asciiY}`: mouseDrag
             `ESC[Me${asciiX}${asciiY}`: mouseWheelUp
             `ESC[Md${asciiX}${asciiY}`: mouseWheelDown
             */
            let x = chunk[4]! - 32;
            let y = chunk[5]! - 32;
            if (key[3] === "e" || key[3] === "d") {
                // Mouse wheel up or down
                if (currentScreen == "main") {
                    if (y > 1 && y < rows) {
                        if (key[3] === "d") {
                            onKey(Buffer.from("\u001b[A"));
                        } else {
                            onKey(Buffer.from("\u001b[B"));
                        }
                    }
                }
            } else if (key[3] === "#") {
                if (lastMouseCommand !== null && (lastMouseCommand[3] === "@" || lastMouseCommand[3] === " ")) {
                    // Mouse up
                    if (currentScreen == "main") {
                        if (y == 1 && x > 52 && x < 69) {
                            // Clicked on help
                            onKey(Buffer.from("H"));
                        }
                    } else if (currentScreen == "help") {
                        currentScreen = "main";
                        resetUI();
                    }
                } else {
                    // Mouse move
                }
            } else if (key[3] === "@") {
                // Mouse drag
            } else if (key[3] === " ") {
                // Mouse down
            }
            
            lastMouseCommand = key;
            return;
        }
        if (currentScreen == "main") {
            switch (key) {
                case "X":
                case "x":
                case "\u0003": {
                    writeLineWithDateType("Exiting...", "setup");
                    setTimeout(() => {
                        cleanup();
                    }, 2000);
                    break;
                }
                case "F":
                case "f": {
                    writeLineWithDateType("Forcing flush...", "setup");
                    emitter.emit("commit");
                    break;
                }
                case "\u001b[A": { // Up arrow
                    if (scrollTop < backScroll.length - rows + 2) {
                        scrollTop++;
                        process.stdout.write(`\x1B7`); // Save cursor position
                        process.stdout.write(`\x1B[1;1H`); // Move to top-left
                        process.stdout.write(`\x1B[1T`); // Scroll down
                        process.stdout.write(backScroll[backScroll.length - rows + 2 - scrollTop] ?? ""); // Print the line
                        process.stdout.write(`\x1B8`); // Restore cursor position
                    }
                    break;
                }
                case "\u001b[B": { // Down arrow
                    if (scrollTop > 0) {
                        scrollTop--;
                        process.stdout.write(`\x1B7`); // Save cursor position
                        process.stdout.write(`\x1B[${rows - 1};1H`); // Move to bottom-left
                        process.stdout.write(`\x1B[1S`); // Scroll up
                        process.stdout.write(backScroll[backScroll.length - scrollTop] ?? ""); // Print the line
                        process.stdout.write(`\x1B8`); // Restore cursor position
                    }
                    break;
                }
                case "H":
                case "h": {
                    currentScreen = "help";
                    
                    const left = 8;
                    let width  = columns - left * 2;
                    if (width < 10) {
                        width = 10;
                    }
                    let helpLinesWrapped: string[] = [];
                    for (const line of helpLines) {
                        if (line == "") {
                            helpLinesWrapped.push("");
                            continue;
                        }
                        for (let i = 0; i < line.length; i += width - 8) {
                            helpLinesWrapped.push(line.slice(i, i + width - 8));
                        }
                    }
                    const height = Math.ceil((helpLinesWrapped.length + 6) / 2) * 2;
                    const top    = Math.floor(rows / 2) - Math.floor(height / 2);
                    const bottom = top + height;
                    process.stdout.write("\x1B[38;5;24m"); // Border color
                    process.stdout.write(`\x1B[${top};${left}H`); // Move to top-left of box
                    process.stdout.write(`╔${new Array(width - 2).fill("═").join("")}╗`); // Top border
                    for (let i = top + 1; i < bottom - 1; i++) {
                        process.stdout.write(`\x1B[${i};${left}H`); // Move to left border
                        process.stdout.write(`║${new Array(width - 2).fill(" ").join("")}║`); // Right border
                    }
                    process.stdout.write(`\x1B[${bottom - 1};${left}H`);
                    process.stdout.write(`╚${new Array(width - 2).fill("═").join("")}╝`); // Bottom border
                    
                    process.stdout.write(`\x1B[${top + 2};${left + Math.floor((width - clearAnsiEscape(helpTitle).length) / 2)}H`); // Move to start of title
                    process.stdout.write(helpTitle); // Title
                    
                    for (let i = 0; i < helpLinesWrapped.length; i++) {
                        process.stdout.write(`\x1B[${top + 4 + i};${left + 4}H`); // Move to start of line
                        process.stdout.write(helpLinesWrapped[i]!); // Line
                    }
                    break;
                }
                case "r":
                case "R": {
                    if (existsSync(config.outputFolder)) {
                        writeLineWithDateType(`Cleaning up output folder: ${config.outputFolder}`, "setup");
                        rmSync(config.outputFolder, {recursive: true, force: true});
                    }
                    watcher?.close();
                    eventsToFlush.splice(0, Infinity);
                    rmSync(tempName, {recursive: true, force: true});
                    mkdirSync(tempName, {recursive: true});
                    flushing    = false;
                    lastChanged = null;
                    emitter     = new EventEmitter();
                    process.off("SIGINT", cleanup);
                    process.off("SIGTERM", cleanup);
                    process.off("SIGTSTP", cleanup);
                    process.stdin.off("data", onKey);
                    writeLineWithDateType("Restarting...", "setup");
                    setTimeout(() => {
                        process.stdout.write("\x1Bc"); // Clear screen
                        process.stdout.write("\x1Br"); // Reset region
                        void main();
                    }, 2000);
                    break;
                }
                default:
                    writeLineWithDateType("Unknown command: " + JSON.stringify(key), "setup");
            }
        } else if (currentScreen == "help") {
            currentScreen = "main";
            resetUI();
        } else {
            if (key === "\u0003") { // Ctrl+C
                cleanup();
            }
        }
    };
    process.stdin.on("data", onKey);
    
    await ensureCleanOutputFolder();
    copyOrSymlinkRecursive(config.linkFolder, config.outputFolder);
    
    writeLineWithDateType(`Creating cache directory: ${tempName}`, "setup");
    mkdirSync(tempName, {recursive: true});
    
    await watchEverything(config.linkFolder);
    
    emitter.on("commit", () => {
        if (!flushing) {
            writeLineWithDateType("Flushing all touched files due to commit trigger...", "flush");
            flushing = true;
            writeUI();
            flushTouchedFiles();
            flushing = false;
            writeLineWithDateType("Flush finished", "flush");
            writeUI();
        }
    });
    lastFlushed = new Date();
    writeUI();
    
    // Cleanup output folder on SIGINT, SIGTERM, SIGTSTP
    const cleanup = () => {
        if (existsSync(config.outputFolder)) {
            writeLineWithDateType(`Cleaning up output folder: ${config.outputFolder}`, "setup");
            rmSync(config.outputFolder, {recursive: true, force: true});
        }
        if (existsSync(tempName)) {
            writeLineWithDateType(`Cleaning up cache folder: ${tempName}`, "setup");
            rmSync(tempName, {recursive: true, force: true});
        }
        watcher.close();
        process.stdout.write("\x1Bc"); // Clear screen
        process.stdout.write("\x1Br"); // Reset region
        process.stdout.write(`\x1B[?25h`); // Show cursor
        process.stdout.write("\x1b[?1003l"); // Disable mouse move events
        process.exit(0);
    };
    
    
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGTSTP", cleanup); // SIGTSTP is typically sent by Ctrl+Z
    
    process.on("SIGWINCH", () => {
        let newColumns = process.stdout.columns ?? 80;
        let newRows    = process.stdout.rows ?? 24;
        if (newColumns !== columns || newRows !== rows) {
            columns = newColumns;
            rows    = newRows;
            resetUI();
        }
    });
    
    process.on("uncaughtException", (err) => {
        process.stdout.write("\x1Bc"); // Clear screen
        process.stdout.write("\x1Br"); // Reset region
        console.error("Uncaught exception:", err);
    });
};

void main();
