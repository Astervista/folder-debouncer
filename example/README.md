# Example

`project/` stands in for a real project: `src/` holds the sources and `dist/` the build output.

```sh
npm run example          # from the repository root
```

The output folder `/tmp/folder-debouncer-example` then contains:

- `dist/` as a **real copy**: changes to it are held back;
- `src/` and `package.json` as **symlinks**, so they are always live;
- no `notes/`, because it is ignored.

Try it from another terminal:

```sh
echo 'console.log("v2");' > example/project/dist/main.js   # shows up as pending
touch example/project/dist/build-complete                 # commit trigger: everything is flushed
```
