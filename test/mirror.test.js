const test = require("node:test");
const assert = require("node:assert");
const {mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, renameSync, rmSync, readlinkSync} = require("node:fs");
const {join} = require("node:path");
const {parseConfig} = require("../dist/config.js");
const {Mirror} = require("../dist/mirror.js");
const {watch} = require("../dist/file-watcher.js");
const {tempDir, sleep, waitFor, FIXTURE_SETTLE} = require("./helpers.js");

/**
 * project/
 *   package.json         -> symlinked
 *   src/app.ts           -> symlinked (whole src folder)
 *   dist/                -> watched: copied, changes debounced
 *     main.js
 *     done.txt           -> commit trigger
 *   secret/              -> ignored
 */
async function setup(t, {startWatcher = true} = {}) {
    const dir = tempDir(t);
    const project = join(dir, "project");
    mkdirSync(join(project, "src"), {recursive: true});
    mkdirSync(join(project, "dist"));
    mkdirSync(join(project, "secret"));
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, "src", "app.ts"), "app");
    writeFileSync(join(project, "dist", "main.js"), "v1");
    writeFileSync(join(project, "secret", "key"), "k");
    
    const config = parseConfig({
        linkFolder:     "project",
        outputFolder:   "out",
        watch:          ["dist"],
        commitTriggers: ["dist/done.txt"],
        ignore:         ["secret"]
    }, dir);
    const logs = [];
    const mirror = new Mirror(config, (message, type) => logs.push({message, type}));
    t.after(() => mirror.dispose());
    
    assert.ok(await mirror.prepareOutput(async () => assert.fail("should not ask for an empty output")));
    let watcher = null;
    if (startWatcher) {
        await sleep(FIXTURE_SETTLE);
        watcher = await watch(config.linkFolder, {ignored: config.ignore, tracked: config.watch});
        t.after(() => watcher.close());
        watcher.listen((...args) => mirror.handleEvent(...args));
    }
    mirror.initialMirror();
    return {dir, project, out: join(dir, "out"), mirror, logs};
}

test("the initial mirror copies watched paths and symlinks everything else", async t => {
    const {project, out} = await setup(t, {startWatcher: false});
    assert.ok(lstatSync(join(out, "package.json")).isSymbolicLink());
    assert.strictEqual(readlinkSync(join(out, "src")), join(project, "src"));
    assert.ok(lstatSync(join(out, "dist")).isDirectory());
    assert.ok(lstatSync(join(out, "dist", "main.js")).isFile());
    assert.strictEqual(readFileSync(join(out, "dist", "main.js"), "utf-8"), "v1");
    assert.ok(!existsSync(join(out, "secret")));
});

test("changes to watched files are held back until a commit trigger", async t => {
    const {project, out, mirror} = await setup(t);
    let triggered = 0;
    mirror.onTrigger = () => {
        triggered++;
        mirror.flush();
    };
    
    writeFileSync(join(project, "dist", "main.js"), "v2");
    writeFileSync(join(project, "dist", "chunk.js"), "chunk");
    await waitFor(() => mirror.pending.length >= 2, "changes queued");
    assert.strictEqual(readFileSync(join(out, "dist", "main.js"), "utf-8"), "v1");
    assert.ok(!existsSync(join(out, "dist", "chunk.js")));
    
    writeFileSync(join(project, "dist", "done.txt"), "ok");
    await waitFor(() => triggered > 0, "commit trigger");
    assert.strictEqual(readFileSync(join(out, "dist", "main.js"), "utf-8"), "v2");
    assert.strictEqual(readFileSync(join(out, "dist", "chunk.js"), "utf-8"), "chunk");
    assert.strictEqual(mirror.pending.length, 0);
});

test("the flushed content is the snapshot taken when the change happened", async t => {
    const {project, out, mirror} = await setup(t);
    writeFileSync(join(project, "dist", "main.js"), "v2");
    await waitFor(() => mirror.pending.length >= 1, "change queued");
    mirror.flush();
    assert.strictEqual(readFileSync(join(out, "dist", "main.js"), "utf-8"), "v2");
});

test("renames and deletes inside watched folders are applied on flush", async t => {
    const {project, out, mirror} = await setup(t);
    mkdirSync(join(project, "dist", "sub"));
    writeFileSync(join(project, "dist", "sub", "a.js"), "a");
    await waitFor(() => mirror.pending.some(e => e.path.endsWith("a.js")), "create queued");
    renameSync(join(project, "dist", "sub", "a.js"), join(project, "dist", "sub", "b.js"));
    rmSync(join(project, "dist", "main.js"));
    await waitFor(() => mirror.pending.some(e => e.event === "D"), "delete queued");
    await waitFor(() => mirror.pending.some(e => e.event === "R"), "rename queued");
    
    mirror.flush();
    assert.ok(!existsSync(join(out, "dist", "main.js")));
    assert.ok(!existsSync(join(out, "dist", "sub", "a.js")));
    assert.strictEqual(readFileSync(join(out, "dist", "sub", "b.js"), "utf-8"), "a");
});

test("unwatched additions and removals are linked immediately", async t => {
    const {project, out, mirror} = await setup(t);
    writeFileSync(join(project, "README.md"), "hi");
    await waitFor(() => existsSync(join(out, "README.md")), "symlink created");
    assert.ok(lstatSync(join(out, "README.md")).isSymbolicLink());
    
    rmSync(join(project, "package.json"));
    await waitFor(() => !existsSync(join(out, "package.json")) && !isLink(join(out, "package.json")), "symlink removed");
    assert.strictEqual(mirror.pending.length, 0);
});

test("moving a file from an unwatched folder into a watched one is a create", async t => {
    const {project, out, mirror} = await setup(t);
    renameSync(join(project, "package.json"), join(project, "dist", "package.json"));
    await waitFor(() => mirror.pending.some(e => e.path === join(project, "dist", "package.json")), "create queued");
    await waitFor(() => !isLink(join(out, "package.json")), "old symlink removed");
    mirror.flush();
    assert.ok(lstatSync(join(out, "dist", "package.json")).isFile());
    // The source must not have been touched
    assert.strictEqual(readFileSync(join(project, "dist", "package.json"), "utf-8"), "{}");
});

test("dispose removes the output folder only if it was prepared", async t => {
    const {out, mirror} = await setup(t, {startWatcher: false});
    mirror.dispose();
    assert.ok(!existsSync(out));
});

test("a refused cleanup leaves the output folder alone", async t => {
    const dir = tempDir(t);
    mkdirSync(join(dir, "project"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "precious.txt"), "keep me");
    const config = parseConfig({linkFolder: "project", outputFolder: "out"}, dir);
    const mirror = new Mirror(config, () => {});
    assert.strictEqual(await mirror.prepareOutput(async () => false), false);
    mirror.dispose();
    assert.strictEqual(readFileSync(join(dir, "out", "precious.txt"), "utf-8"), "keep me");
});

function isLink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}
