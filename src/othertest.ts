import {watch} from "./file-watcher.js";

watch(
    "/Users/asteriofiora/WebstormProjects/folder-debouncer",
    {ignored: ["/Users/asteriofiora/WebstormProjects/folder-debouncer/test-dir/ignored", "/Users/asteriofiora/WebstormProjects/folder-debouncer/node_modules", "/Users/asteriofiora/WebstormProjects/folder-debouncer/.git"]}
).then((watcher) => {
    
    watcher.listen((type, fileType, path, oldPath) => {
        console.log(type, fileType, path, oldPath);
    });
    
})
 .catch((err) => {
     console.log(err);
 });
