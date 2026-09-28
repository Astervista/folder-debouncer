# Example

`project/` is a tiny TypeScript app. `debouncer.json` holds back its `src/` folder and mirrors it to
`/tmp/folder-debouncer-example`.

From the repository root, in three terminals:

```sh
# 1. The gate
npm run example

# 2. The watcher, running in the mirror
cd /tmp/folder-debouncer-example && npx tsc --watch

# 3. Pretend to be an editor that saves on every keystroke
cd example/project
echo 'export function greeting(name: string): string { return `Hi' > src/greeting.ts
echo 'export function greeting(name: string): string { return `Hi, ${name}`; }' > src/greeting.ts
```

`tsc` stays quiet: the dashboard shows the changes as pending. Now flush:

```sh
node ../../dist/index.js --flush ../debouncer.json    # or press F in the dashboard
```

`tsc` rebuilds once, with the final version. Restore the file with `git checkout example/project/src`.
