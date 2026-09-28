const {mkdtempSync, realpathSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");

/** Creates a temporary folder (with symlinks resolved, as FSEvents reports them) and removes it after the test. */
function tempDir(t) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "folder-debouncer-test-")));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    return dir;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `predicate` until it returns true, failing after `timeout` ms. */
async function waitFor(predicate, message, timeout = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) {
            throw new Error(`Timed out waiting for: ${message}`);
        }
        await sleep(50);
    }
}

// FSEvents may drop events from the first moments of a new stream
const WATCHER_WARMUP = 1500;

module.exports = {tempDir, sleep, waitFor, WATCHER_WARMUP};
