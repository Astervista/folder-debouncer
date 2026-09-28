import {readFileSync, statSync} from "node:fs";
import {basename, dirname, resolve} from "node:path";
import {isInside, realpathLoose} from "./paths.js";

export const DEFAULT_CONFIG_FILE = "debouncer.json";

/** The config file as written by the user; see config.schema.json. */
export interface ConfigJSON {
    $schema?: string;
    linkFolder: string;
    watch?: string | string[];
    commitTriggers?: string | string[];
    ignore?: string | string[];
    outputFolder: string;
}

/** The validated config, with every path absolute and symlink-free. */
export interface Config {
    linkFolder: string;
    watch: string[];
    commitTriggers: string[];
    ignore: string[];
    outputFolder: string;
}

export class ConfigError extends Error {
    override name = "ConfigError";
}

export const FLUSH_FILE = ".debouncer-flush";

/** A starter config for a project in `dir`: sources in src/ are held back, the mirror is a sibling folder. */
export function configTemplate(dir: string): ConfigJSON {
    return {
        $schema:        "https://unpkg.com/folder-debouncer/config.schema.json",
        linkFolder:     ".",
        outputFolder:   `../${basename(dir)}-debounced`,
        watch:          ["src"],
        commitTriggers: [FLUSH_FILE],
        ignore:         []
    };
}

const KNOWN_KEYS = new Set(["$schema", "linkFolder", "watch", "commitTriggers", "ignore", "outputFolder"]);

export function loadConfig(configPath: string): Config {
    const absolutePath = resolve(configPath);
    let text: string;
    try {
        text = readFileSync(absolutePath, "utf-8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ConfigError(`Config file not found: ${absolutePath}\nRun "debouncer --init" to create one.`);
        }
        throw new ConfigError(`Cannot read config file ${absolutePath}: ${(e as Error).message}`);
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new ConfigError(`Config file ${absolutePath} is not valid JSON: ${(e as Error).message}`);
    }

    return parseConfig(json, dirname(absolutePath));
}

/**
 * Validates a parsed config file. `linkFolder` and `outputFolder` are resolved relative to `baseDir`
 * (the folder containing the config file), every other path relative to `linkFolder`.
 */
export function parseConfig(json: unknown, baseDir: string): Config {
    if (typeof json !== "object" || json == null || Array.isArray(json)) {
        throw new ConfigError("The config must be a JSON object.");
    }
    const raw    = json as Record<string, unknown>;
    const errors: string[] = [];

    for (const key of Object.keys(raw)) {
        if (!KNOWN_KEYS.has(key)) {
            errors.push(`Unknown option "${key}".`);
        }
    }

    const requiredString = (key: string): string | null => {
        const value = raw[key];
        if (typeof value !== "string" || value.trim() === "") {
            errors.push(`"${key}" is required and must be a non-empty string.`);
            return null;
        }
        return value;
    };

    const stringList = (key: string): string[] => {
        const value = raw[key];
        if (value == null) {
            return [];
        }
        if (typeof value === "string") {
            return [value];
        }
        if (Array.isArray(value) && value.every(item => typeof item === "string")) {
            return value as string[];
        }
        errors.push(`"${key}" must be a string or an array of strings.`);
        return [];
    };

    const linkFolderValue   = requiredString("linkFolder");
    const outputFolderValue = requiredString("outputFolder");
    const watchValues       = stringList("watch");
    const triggerValues     = stringList("commitTriggers");
    const ignoreValues      = stringList("ignore");

    if (linkFolderValue == null || outputFolderValue == null) {
        throw new ConfigError(errors.join("\n"));
    }

    const linkFolderPath = resolve(baseDir, linkFolderValue);
    let isDirectory      = false;
    try {
        isDirectory = statSync(linkFolderPath).isDirectory();
    } catch {
        // Reported below
    }
    if (!isDirectory) {
        errors.push(`"linkFolder" ${linkFolderPath} does not exist or is not a directory.`);
        throw new ConfigError(errors.join("\n"));
    }

    const linkFolder   = realpathLoose(linkFolderPath);
    const outputFolder = realpathLoose(resolve(baseDir, outputFolderValue));

    const insideLinkFolder = (key: string, values: string[]): string[] => values.map(value => {
        const path = realpathLoose(resolve(linkFolder, value));
        if (!isInside(path, linkFolder)) {
            errors.push(`"${key}" entry "${value}" must be inside the link folder (${linkFolder}).`);
        }
        return path;
    });

    const watch          = insideLinkFolder("watch", watchValues);
    const commitTriggers = insideLinkFolder("commitTriggers", triggerValues);
    const ignore         = insideLinkFolder("ignore", ignoreValues);

    // The output folder is wiped on start and on exit, so it must never overlap the sources
    if (isInside(outputFolder, linkFolder)) {
        errors.push(`"outputFolder" (${outputFolder}) must not be inside the link folder (${linkFolder}).`);
    } else if (isInside(linkFolder, outputFolder)) {
        errors.push(`"outputFolder" (${outputFolder}) must not contain the link folder (${linkFolder}).`);
    }

    if (errors.length > 0) {
        throw new ConfigError(errors.join("\n"));
    }

    return {linkFolder, outputFolder, watch, commitTriggers, ignore};
}
