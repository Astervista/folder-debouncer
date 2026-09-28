import {LogType} from "./mirror.js";

export interface Status {
    state: "starting" | "idle" | "pending" | "flushing" | "stopped";
    created: number;
    renamed: number;
    modified: number;
    deleted: number;
    lastChanged: Date | null;
    lastFlushed: Date | null;
}

interface LogEntry {
    text: string;
    type: LogType;
    date: Date;
}

const ICONS: Record<LogType, string> = {
    flush:  "\x1B[38;5;36m ▼",
    edit:   "\x1B[38;5;208m✏︎",
    setup:  "\x1B[38;5;45m⚙︎",
    delete: "\x1B[38;5;197m✖︎",
    create: "\x1B[38;5;42m✶︎",
    rename: "\x1B[38;5;208m⇋",
    error:  "\x1B[38;5;196m⚠︎"
};

/** Width taken by the icon, the spaces and the ": " around the time in each log line. */
const FIXED_DIFFERENCE = 5;
const MAX_LOG_ENTRIES  = 5000;

const TITLE     = "\x1B[1m\x1B[39mFolder Debouncer\x1B[22m is running. Press X to exit, H for help.";
const HELP_HINT = "H for help";
const LEGEND    = "Legend: \x1B[38;5;42m✶︎ Created  \x1B[38;5;208m✏︎ Modified  \x1B[38;5;208m⇋ Renamed  \x1B[38;5;197m✖︎ Deleted  \x1B[38;5;36m▼ Flushed  \x1B[38;5;45m⚙︎ Setup\x1B[0m";

const HELP_TITLE = "\x1B[1m\x1B[38;5;75mFolder Debouncer\x1B[22m - Help\x1B[0m";
const HELP_LINES = [
    "This tool mirrors a folder into an output folder. Watched paths are copied, and changes to them are not " +
    "mirrored in real time: they are collected and flushed all at once when a commit trigger file changes, or " +
    "when you force a flush. Everything else is symlinked, so it is always up to date.",
    "",
    "At any point, you can press one of the following keys to perform an action:",
    "",
    "   X, ^C: Exit (the output folder is deleted)",
    "       F: Flush all pending changes now",
    "       R: Restart, reloading the config file",
    " Up/Down: Scroll the log (the mouse wheel works too)",
    "       H: Show this help",
    "",
    "Press any key to return to the main screen."
];

export function clearAnsiEscape(str: string): string {
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export interface TerminalUIHandlers {
    onKey: (key: string) => void;
    getStatus: () => Status;
}

/**
 * Full-screen terminal UI: a title bar, a scrollable log and a status bar.
 * Runs on the alternate screen, so the user's terminal is restored untouched on exit.
 */
export class TerminalUI {
    private columns = process.stdout.columns || 80;
    private rows    = process.stdout.rows || 24;

    private readonly entries: LogEntry[] = [];
    /** Rendered (wrapped) log lines. */
    private backScroll: string[]         = [];
    private scrollTop                    = 0;
    private screen: "main" | "help"      = "main";
    private active                       = false;
    private lastMouseCommand: string | null = null;
    private pendingConfirm: ((answer: boolean) => void) | null = null;
    private statusScheduled              = false;

    constructor(private readonly handlers: TerminalUIHandlers) {
    }

    start() {
        this.active = true;
        process.stdout.write("\x1B[?1049h"); // Switch to the alternate screen
        process.stdout.write("\x1B[?1003h"); // Enable mouse move events
        process.stdout.write("\x1B[?25l"); // Hide cursor
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", this.onData);
        process.stdout.on("resize", this.onResize);
        this.redraw();
    }

    /** Restores the terminal. Safe to call more than once, and from crash handlers. */
    restore() {
        if (!this.active) {
            return;
        }
        this.active = false;
        process.stdin.off("data", this.onData);
        process.stdout.off("resize", this.onResize);
        process.stdout.write("\x1B[r"); // Reset scroll region
        process.stdout.write("\x1B[0m"); // Reset text
        process.stdout.write("\x1B[?1003l"); // Disable mouse move events
        process.stdout.write("\x1B[?25h"); // Show cursor
        process.stdout.write("\x1B[?1049l"); // Back to the main screen
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.pause();
    }

    log(text: string, type: LogType, date: Date = new Date()) {
        const entry = {text, type, date};
        this.entries.push(entry);
        if (this.entries.length > MAX_LOG_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
            this.rebuildBackScroll();
        } else {
            this.backScroll.push(...this.formatEntry(entry));
        }

        if (!this.active || this.screen != "main") {
            return;
        }
        if (this.scrollTop > 0) {
            // Jump back to the bottom so the new line is visible
            this.scrollTop = 0;
            this.redrawLog();
        } else {
            for (const line of this.formatEntry(entry)) {
                process.stdout.write(`${line}\n`);
            }
        }
        this.scheduleStatus();
    }

    /** Asks a yes/no question in the log. Y answers yes; N, Esc and Ctrl+C answer no; other keys are ignored. */
    confirm(question: string): Promise<boolean> {
        this.log(question, "setup");
        return new Promise(resolve => {
            this.pendingConfirm = resolve;
        });
    }

    /** Redraws the title and status bars on the next tick. */
    scheduleStatus() {
        if (this.statusScheduled) {
            return;
        }
        this.statusScheduled = true;
        setImmediate(() => {
            this.statusScheduled = false;
            this.writeBars();
        });
    }

    scroll(delta: number) {
        const visible   = this.rows - 3;
        const maxScroll = Math.max(0, this.backScroll.length - visible);
        const next      = Math.min(maxScroll, Math.max(0, this.scrollTop + delta));
        if (next !== this.scrollTop) {
            this.scrollTop = next;
            this.redrawLog();
        }
    }

    showHelp() {
        this.screen = "help";

        const left = 8;
        const width = Math.max(20, this.columns - left * 2);
        const helpLinesWrapped: string[] = [];
        for (const line of HELP_LINES) {
            helpLinesWrapped.push(...wrap(line, width - 8));
        }
        const height = Math.ceil((helpLinesWrapped.length + 6) / 2) * 2;
        const top = Math.max(1, Math.floor(this.rows / 2) - Math.floor(height / 2));
        const bottom = top + height;

        process.stdout.write("\x1B[38;5;24m"); // Border color
        process.stdout.write(`\x1B[${top};${left}H`); // Move to top-left of box
        process.stdout.write(`╔${"═".repeat(width - 2)}╗`); // Top border
        for (let i = top + 1; i < bottom - 1; i++) {
            process.stdout.write(`\x1B[${i};${left}H`); // Move to left border
            process.stdout.write(`║${" ".repeat(width - 2)}║`); // Right border
        }
        process.stdout.write(`\x1B[${bottom - 1};${left}H`);
        process.stdout.write(`╚${"═".repeat(width - 2)}╝`); // Bottom border

        process.stdout.write(`\x1B[${top + 2};${left + Math.floor((width - clearAnsiEscape(HELP_TITLE).length) / 2)}H`); // Move to start of title
        process.stdout.write(HELP_TITLE); // Title

        process.stdout.write("\x1B[38;5;250m");
        for (let i = 0; i < helpLinesWrapped.length; i++) {
            process.stdout.write(`\x1B[${top + 4 + i};${left + 4}H`); // Move to start of line
            process.stdout.write(helpLinesWrapped[i]!); // Line
        }
        process.stdout.write("\x1B[0m");
    }

    private closeHelp() {
        this.screen = "main";
        this.redraw();
    }

    // --- Input ---

    private readonly onData = (chunk: Buffer) => {
        const key = chunk.toString();

        if (this.pendingConfirm != null) {
            const resolve = this.pendingConfirm;
            const yes     = key == "y" || key == "Y";
            const no      = key == "n" || key == "N" || key == "\u0003" || key == "\x1b";
            if (yes || no) {
                this.pendingConfirm = null;
                resolve(yes);
            }
            return;
        }

        if (key.startsWith("\x1b[M")) {
            this.onMouse(chunk, key);
            return;
        }

        if (this.screen == "help" && key !== "\u0003") {
            this.closeHelp();
            return;
        }
        this.handlers.onKey(key);
    };

    private onMouse(chunk: Buffer, key: string) {
        /*
         LEGEND:
         `ESC[M#${asciiX}${asciiY}`: mouseMove or mouseUp if dragging or down
         `ESC[M ${asciiX}${asciiY}`: mouseDown
         `ESC[M@${asciiX}${asciiY}`: mouseDrag
         `ESC[M\`${asciiX}${asciiY}` or `ESC[Me...`: mouseWheelUp
         `ESC[Ma${asciiX}${asciiY}` or `ESC[Md...`: mouseWheelDown
         */
        const x      = (chunk[4] ?? 32) - 32;
        const y      = (chunk[5] ?? 32) - 32;
        const button = key[3];

        if (button === "d" || button === "e" || button === "`" || button === "a") {
            if (this.screen == "main" && y > 1 && y < this.rows) {
                this.scroll(button === "d" || button === "`" ? 1 : -1);
            }
        } else if (button === "#") {
            if (this.lastMouseCommand !== null && (this.lastMouseCommand[3] === "@" || this.lastMouseCommand[3] === " ")) {
                // Mouse up
                if (this.screen == "main") {
                    const hintStart = clearAnsiEscape(TITLE).indexOf(HELP_HINT) + 1;
                    if (y == 1 && x >= hintStart && x < hintStart + HELP_HINT.length) {
                        this.handlers.onKey("h");
                    }
                } else {
                    this.closeHelp();
                }
            }
        }

        this.lastMouseCommand = key;
    }

    private readonly onResize = () => {
        const newColumns = process.stdout.columns || 80;
        const newRows    = process.stdout.rows || 24;
        if (newColumns !== this.columns || newRows !== this.rows) {
            this.columns = newColumns;
            this.rows    = newRows;
            this.rebuildBackScroll();
            this.redraw();
        }
    };

    // --- Rendering ---

    private formatEntry(entry: LogEntry): string[] {
        const dateString   = entry.date.toLocaleTimeString();
        const width        = Math.max(10, this.columns - dateString.length - FIXED_DIFFERENCE);
        const wrappedLines = entry.text.split("\n").flatMap(line => wrap(line, width));
        const indent       = " ".repeat(dateString.length + FIXED_DIFFERENCE);

        return [
            `${ICONS[entry.type]}\x1B[38;5;243m ${dateString}: \x1B[38;5;246m${wrappedLines[0] ?? ""}\x1B[0m`,
            ...wrappedLines.slice(1).map(line => `${indent}\x1B[38;5;246m${line}\x1B[0m`)
        ];
    }

    private rebuildBackScroll() {
        this.backScroll = this.entries.flatMap(entry => this.formatEntry(entry));
        this.scrollTop  = Math.min(this.scrollTop, Math.max(0, this.backScroll.length - (this.rows - 3)));
    }

    private redraw() {
        if (!this.active) {
            return;
        }
        process.stdout.write("\x1B[2J"); // Clear screen
        this.writeBars();
        this.redrawLog();
        if (this.screen == "help") {
            this.showHelp();
        }
    }

    /**
     * Repaints the log region (rows 2 to rows - 1). The last row of the region is kept empty: that is where the
     * cursor waits for the next line.
     */
    private redrawLog() {
        const height  = this.rows - 2;
        const end     = this.backScroll.length - this.scrollTop;
        const visible = this.backScroll.slice(Math.max(0, end - (height - 1)), end);
        for (let i = 0; i < height; i++) {
            process.stdout.write(`\x1B[${2 + i};1H\x1B[2K`); // Move to row and clear it
            process.stdout.write(visible[i] ?? "");
        }
        process.stdout.write(`\x1B[${2 + visible.length};1H`); // Park the cursor below the last line
    }

    private writeBars() {
        if (!this.active) {
            return;
        }
        const out    = process.stdout;
        const status = this.handlers.getStatus();

        out.write("\x1B7"); // Save cursor position
        out.write("\x1B[r"); // Reset region
        out.write("\x1B[1;1H"); // Move to top-left
        out.write("\x1B[2K"); // Clear line
        out.write(TITLE);
        out.write("\x1B[0m");
        const legendLength = clearAnsiEscape(LEGEND).length;
        if (clearAnsiEscape(TITLE).length + legendLength + 2 <= this.columns) {
            out.write(`\x1B[1;${this.columns - legendLength}H`); // Move to top-right
            out.write(LEGEND);
        }
        out.write("\x1B[0m"); // Reset text

        out.write(`\x1B[${this.rows};1H`); // Move to last line
        out.write("\x1B[2K"); // Clear line
        out.write("Status: ");
        out.write("\x1B[1m"); // Bold text
        switch (status.state) {
            case "flushing":
                out.write("\x1B[38;5;197m● Flushing changes...");
                break;
            case "starting":
                out.write("\x1B[38;5;45m● Starting...");
                break;
            case "stopped":
                out.write("\x1B[38;5;196m● Watcher stopped - press R to restart");
                break;
            case "idle":
                out.write("\x1B[38;5;78m● No changes");
                break;
            case "pending":
                out.write("\x1B[38;5;208m● Changes pending");
                break;
        }
        out.write("\x1B[0m"); // Reset text

        const counter = (count: number, icon: string) => count > 0 ? `${icon} ${count}\x1B[0m` : "";
        const infoString = [
            counter(status.created, "\x1B[38;5;42m✶︎"),
            counter(status.renamed, "\x1B[38;5;208m⇋"),
            counter(status.modified, "\x1B[38;5;208m✏︎"),
            counter(status.deleted, "\x1B[38;5;197m✖︎")
        ].filter(s => s !== "").join(" | ");

        const lastChangedString = status.lastChanged == null ? "" : `\x1B[38;5;208m✏︎ ${status.lastChanged.toLocaleTimeString()}\x1B[0m`;
        const lastFlushedString = status.lastFlushed == null ? "" : `\x1B[38;5;36m▼ ${status.lastFlushed.toLocaleTimeString()}\x1B[0m`;
        let timeString = [lastChangedString, lastFlushedString].filter(s => s !== "").join(" - ");
        if (timeString.length > 0) {
            timeString = "⏲: " + timeString;
        }
        const fullString = [infoString, timeString].filter(s => s !== "").join(" | ");
        const fullLength = clearAnsiEscape(fullString).length;
        if (fullLength + 40 <= this.columns) {
            out.write(`\x1B[${this.rows};${this.columns - fullLength}H`); // Move to bottom-right
            out.write(fullString);
        }

        out.write(`\x1B[2;${this.rows - 1}r`); // Create central region
        out.write("\x1B8"); // Restore cursor position
        out.write("\x1B[0m"); // Reset text
    }
}

function wrap(line: string, width: number): string[] {
    if (line.length === 0) {
        return [""];
    }
    const lines: string[] = [];
    for (let i = 0; i < line.length; i += width) {
        lines.push(line.slice(i, i + width));
    }
    return lines;
}
