const test = require("node:test");
const assert = require("node:assert");
const {mkdirSync, writeFileSync} = require("node:fs");
const {join} = require("node:path");
const {parseConfig, loadConfig, ConfigError} = require("../dist/config.js");
const {tempDir} = require("./helpers.js");

function setup(t) {
    const dir = tempDir(t);
    mkdirSync(join(dir, "project", "dist"), {recursive: true});
    return dir;
}

test("resolves paths relative to the config folder and the link folder", t => {
    const dir = setup(t);
    const config = parseConfig({
        linkFolder:     "project",
        outputFolder:   "out",
        watch:          "dist",
        commitTriggers: ["dist/done.txt"]
    }, dir);
    assert.deepStrictEqual(config, {
        linkFolder:     join(dir, "project"),
        outputFolder:   join(dir, "out"),
        watch:          [join(dir, "project", "dist")],
        commitTriggers: [join(dir, "project", "dist", "done.txt")],
        ignore:         []
    });
});

test("accepts a $schema key", t => {
    const dir = setup(t);
    assert.doesNotThrow(() => parseConfig({$schema: "x", linkFolder: "project", outputFolder: "out"}, dir));
});

test("rejects missing required fields and unknown keys", t => {
    const dir = setup(t);
    assert.throws(() => parseConfig({outputFolder: "out"}, dir), /"linkFolder" is required/);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "out", watchh: []}, dir), /Unknown option "watchh"/);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "out", watch: [1]}, dir), /"watch" must be a string or an array/);
    assert.throws(() => parseConfig([], dir), ConfigError);
});

test("rejects a link folder that does not exist", t => {
    const dir = setup(t);
    assert.throws(() => parseConfig({linkFolder: "nope", outputFolder: "out"}, dir), /does not exist/);
});

test("rejects paths outside the link folder", t => {
    const dir = setup(t);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "out", watch: "../elsewhere"}, dir), /must be inside the link folder/);
    // A sibling sharing the prefix is outside too
    mkdirSync(join(dir, "project-other"));
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "out", ignore: "../project-other"}, dir), /must be inside the link folder/);
});

test("rejects an output folder overlapping the link folder", t => {
    const dir = setup(t);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "project/out"}, dir), /must not be inside the link folder/);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "."}, dir), /must not contain the link folder/);
    assert.throws(() => parseConfig({linkFolder: "project", outputFolder: "project"}, dir), /must not be inside the link folder/);
});

test("loadConfig reports missing files and invalid JSON clearly", t => {
    const dir = setup(t);
    assert.throws(() => loadConfig(join(dir, "missing.json")), /Config file not found.*\n.*--init/);
    writeFileSync(join(dir, "bad.json"), "{ nope");
    assert.throws(() => loadConfig(join(dir, "bad.json")), /is not valid JSON/);
    writeFileSync(join(dir, "good.json"), JSON.stringify({linkFolder: "project", outputFolder: "out"}));
    assert.strictEqual(loadConfig(join(dir, "good.json")).linkFolder, join(dir, "project"));
});
