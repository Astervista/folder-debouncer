const test = require("node:test");
const assert = require("node:assert");
const {isInside, realpathLoose} = require("../dist/paths.js");
const {tempDir} = require("./helpers.js");
const {join} = require("node:path");

test("isInside matches the folder itself and its descendants", () => {
    assert.ok(isInside("/a/b", "/a/b"));
    assert.ok(isInside("/a/b/c/d", "/a/b"));
    assert.ok(isInside("/a/b/", "/a/b"));
});

test("isInside does not match siblings sharing a prefix", () => {
    assert.ok(!isInside("/a/bc", "/a/b"));
    assert.ok(!isInside("/a", "/a/b"));
    assert.ok(!isInside("/x/b", "/a/b"));
});

test("isInside handles names starting with two dots", () => {
    assert.ok(isInside("/a/..hidden", "/a"));
});

test("realpathLoose resolves the existing part of a path that does not exist yet", t => {
    const dir = tempDir(t);
    assert.strictEqual(realpathLoose(join(dir, "missing", "file")), join(dir, "missing", "file"));
    assert.strictEqual(realpathLoose("/tmp/does-not-exist-123"), "/private/tmp/does-not-exist-123");
});
