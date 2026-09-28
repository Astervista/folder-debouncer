const test = require("node:test");
const assert = require("node:assert");
const {mkdirSync, writeFileSync, renameSync, rmSync, appendFileSync} = require("node:fs");
const {join} = require("node:path");
const {watch, parseWatcherLine, splitEscaped} = require("../dist/file-watcher.js");
const {tempDir, sleep, waitFor, FIXTURE_SETTLE} = require("./helpers.js");

test("splitEscaped honours escaped delimiters", () => {
    assert.deepStrictEqual(splitEscaped("CF|/a\\|b|/c\\\\d"), ["CF", "/a|b", "/c\\d"]);
});

test("parseWatcherLine reads events, type and paths", () => {
    assert.deepStrictEqual(parseWatcherLine("CMF|/a/b"), {eventTypes: ["C", "M"], fileType: "F", path: "/a/b", oldPath: undefined});
    assert.deepStrictEqual(parseWatcherLine("RD|/new|/old"), {eventTypes: ["R"], fileType: "D", path: "/new", oldPath: "/old"});
    assert.strictEqual(parseWatcherLine("garbage"), null);
    assert.strictEqual(parseWatcherLine("XF|/a"), null);
});

test("the native watcher reports creates, modifies, renames and deletes", async t => {
    const dir = tempDir(t);
    const root = join(dir, "root");
    mkdirSync(join(root, "a"), {recursive: true});
    mkdirSync(join(root, "ignored"));
    mkdirSync(join(dir, "outside", "moved"), {recursive: true});
    writeFileSync(join(dir, "outside", "moved", "inner.txt"), "x");
    writeFileSync(join(root, "a", "existing.txt"), "x");
    
    await sleep(FIXTURE_SETTLE);
    const watcher = await watch(root, {ignored: [join(root, "ignored")]});
    t.after(() => watcher.close());
    const events = [];
    watcher.listen((type, fileType, path, oldPath) => events.push({type, fileType, path, oldPath}));
    const has = (type, path, oldPath) => events.some(e => e.type === type && e.path === path && (oldPath == null || e.oldPath === oldPath));
    
    writeFileSync(join(root, "a", "new.txt"), "1");
    await waitFor(() => has("C", join(root, "a", "new.txt")), "create");
    
    appendFileSync(join(root, "a", "new.txt"), "2");
    await waitFor(() => has("M", join(root, "a", "new.txt")), "modify");
    
    renameSync(join(root, "a", "new.txt"), join(root, "a", "renamed.txt"));
    await waitFor(() => has("R", join(root, "a", "renamed.txt"), join(root, "a", "new.txt")), "rename");
    
    // Moved out of the tree (like moving to the Trash) is a delete
    renameSync(join(root, "a", "existing.txt"), join(dir, "outside", "existing.txt"));
    await waitFor(() => has("D", join(root, "a", "existing.txt")), "move out");
    
    // A folder moved in is a create, and its contents are tracked for renames
    renameSync(join(dir, "outside", "moved"), join(root, "a", "moved"));
    await waitFor(() => has("C", join(root, "a", "moved")), "move in");
    renameSync(join(root, "a", "moved", "inner.txt"), join(root, "a", "moved", "inner2.txt"));
    await waitFor(() => has("R", join(root, "a", "moved", "inner2.txt"), join(root, "a", "moved", "inner.txt")), "rename inside moved folder");
    
    // Atomic save: write a temp file, then rename it over the original
    writeFileSync(join(root, "a", "renamed.txt.tmp"), "3");
    renameSync(join(root, "a", "renamed.txt.tmp"), join(root, "a", "renamed.txt"));
    await waitFor(() => events.some(e => e.path === join(root, "a", "renamed.txt") && e.type !== "D" && events.indexOf(e) > 3), "atomic save");
    
    writeFileSync(join(root, "ignored", "file.txt"), "x");
    rmSync(join(root, "a", "renamed.txt"));
    await waitFor(() => has("D", join(root, "a", "renamed.txt")), "delete");
    
    assert.ok(!events.some(e => e.path.startsWith(join(root, "ignored"))), "ignored paths are not reported");
});

test("watch rejects when the folder cannot be watched", async () => {
    await assert.rejects(watch("/definitely/not/a/folder"), /watcher exited/);
});
