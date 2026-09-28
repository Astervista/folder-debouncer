const test = require("node:test");
const assert = require("node:assert");
const {execFileSync, spawnSync} = require("node:child_process");
const {mkdirSync, readFileSync, writeFileSync, existsSync} = require("node:fs");
const {basename, join} = require("node:path");
const {tempDir} = require("./helpers.js");

const CLI = join(__dirname, "..", "dist", "index.js");

function run(args, cwd) {
    return spawnSync(process.execPath, [CLI, ...args], {cwd, encoding: "utf-8"});
}

test("--init writes a starter config aimed at src/ and refuses to overwrite it", t => {
    const dir = tempDir(t);
    const first = run(["--init"], dir);
    assert.strictEqual(first.status, 0, first.stderr);
    const config = JSON.parse(readFileSync(join(dir, "debouncer.json"), "utf-8"));
    assert.deepStrictEqual(config.watch, ["src"]);
    assert.deepStrictEqual(config.commitTriggers, [".debouncer-flush"]);
    assert.strictEqual(config.outputFolder, `../${basename(dir)}-debounced`);
    
    const second = run(["--init"], dir);
    assert.strictEqual(second.status, 1);
    assert.match(second.stderr, /already exists/);
});

test("--flush writes the first commit trigger", t => {
    const dir = tempDir(t);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "debouncer.json"), JSON.stringify({
        linkFolder: ".", outputFolder: "../out", watch: ["src"], commitTriggers: ["triggers/.flush"]
    }));
    const result = run(["--flush"], dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Flush requested/);
    assert.ok(existsSync(join(dir, "triggers", ".flush")));
});

test("--flush explains when there is no commit trigger", t => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "debouncer.json"), JSON.stringify({linkFolder: ".", outputFolder: "../out"}));
    const result = run(["--flush"], dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /needs at least one entry in "commitTriggers"/);
});

test("--version and unknown arguments", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    assert.strictEqual(execFileSync(process.execPath, [CLI, "--version"], {encoding: "utf-8"}).trim(), pkg.version);
    const bad = run(["--nope"]);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /Unexpected argument "--nope"/);
});
