/*
 * FSEvents-based file watcher used by folder-debouncer.
 *
 * Usage: watcher <dir> [--ignore <path>]... [--track <path>]...
 *
 * Prints "START" once the stream is delivering events, then one line per event:
 *
 *   <events><type>|<path>[|<old path>]
 *
 * where <events> is one or more of C (created), M (modified), D (deleted),
 * R (renamed; <path> is the new location, <old path> the previous one) and
 * <type> is one of D (directory), F (file), S (symlink). Pipes and
 * backslashes inside paths are escaped with a backslash.
 *
 * Rename detection relies on an inode cache. By default the whole tree is
 * cached; --track restricts the cache to the given subtrees. Renames outside
 * tracked subtrees are reported as a delete of the old path plus a create of
 * the new one.
 *
 * The process exits when stdin is closed, so it never outlives its parent.
 */

#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <string.h>
#include <stdbool.h>
#include <dirent.h>
#include <limits.h>
#include <unistd.h>
#include <fcntl.h>

typedef struct {
    dev_t dev;
    ino_t ino;
} inode_key_t;

typedef struct {
    inode_key_t key;
    char *path;
} inode_entry_t;

typedef struct {
    char **items;
    size_t len;
    size_t cap;
} path_list_t;

static path_list_t ignored_paths = {0};
static path_list_t tracked_paths = {0};

static inode_entry_t *inode_cache = NULL;
static size_t inode_cache_len = 0;
static size_t inode_cache_cap = 0;

static FSEventStreamRef g_stream = NULL;
static char g_root[PATH_MAX];
static bool g_started = false;
static dispatch_source_t g_probe_timer = NULL;

static void *xrealloc(void *ptr, size_t size) {
    void *result = realloc(ptr, size);
    if (!result) {
        fprintf(stderr, "Out of memory\n");
        _exit(1);
    }
    return result;
}

static char *xstrdup(const char *s) {
    char *result = strdup(s);
    if (!result) {
        fprintf(stderr, "Out of memory\n");
        _exit(1);
    }
    return result;
}

static void path_list_add(path_list_t *list, const char *path) {
    if (list->len == list->cap) {
        list->cap = list->cap ? list->cap * 2 : 16;
        list->items = xrealloc(list->items, list->cap * sizeof(char *));
    }
    list->items[list->len++] = xstrdup(path);
}

static bool path_list_contains(const path_list_t *list, const char *path) {
    for (size_t i = 0; i < list->len; i++) {
        if (strcmp(list->items[i], path) == 0) {
            return true;
        }
    }
    return false;
}

static void path_list_clear(path_list_t *list) {
    for (size_t i = 0; i < list->len; i++) {
        free(list->items[i]);
    }
    list->len = 0;
}

/* True if `path` is `prefix` itself or lies inside it. */
static bool path_has_prefix(const char *path, const char *prefix) {
    size_t len = strlen(prefix);
    return strncmp(path, prefix, len) == 0 && (path[len] == '/' || path[len] == '\0');
}

static void normalize_slashes(char *s) {
    char *d = s;
    bool prev_slash = false;

    for (; *s; s++) {
        if (*s == '/') {
            if (!prev_slash) {
                *d++ = *s;
            }
            prev_slash = true;
        } else {
            *d++ = *s;
            prev_slash = false;
        }
    }
    *d = '\0';
}

static void strip_trailing_slash(char *s) {
    size_t len = strlen(s);
    if (len > 1 && s[len - 1] == '/') {
        s[len - 1] = '\0';
    }
}

/* Resolves `path` (absolute or relative to `root`) into `out`. Paths that do
 * not exist yet are kept as given, so they still match once created. */
static void resolve_path(const char *root, const char *path, char out[PATH_MAX]) {
    char full[PATH_MAX];

    if (path[0] == '/') {
        snprintf(full, sizeof(full), "%s", path);
    } else {
        snprintf(full, sizeof(full), "%s/%s", root, path);
    }

    if (!realpath(full, out)) {
        snprintf(out, PATH_MAX, "%s", full);
        normalize_slashes(out);
        strip_trailing_slash(out);
    }
}

static bool is_ignored(const char *path) {
    for (size_t i = 0; i < ignored_paths.len; i++) {
        if (path_has_prefix(path, ignored_paths.items[i])) {
            return true;
        }
    }
    return false;
}

/* True if inodes under `path` should be cached for rename detection. */
static bool is_tracked(const char *path) {
    if (tracked_paths.len == 0) {
        return true;
    }
    for (size_t i = 0; i < tracked_paths.len; i++) {
        if (path_has_prefix(path, tracked_paths.items[i])) {
            return true;
        }
    }
    return false;
}

/* True if `path` is a directory that contains a tracked subtree. */
static bool contains_tracked(const char *path) {
    for (size_t i = 0; i < tracked_paths.len; i++) {
        if (path_has_prefix(tracked_paths.items[i], path)) {
            return true;
        }
    }
    return false;
}

static bool inode_equal(inode_key_t a, inode_key_t b) {
    return a.dev == b.dev && a.ino == b.ino;
}

static inode_entry_t *inode_find(inode_key_t key) {
    for (size_t i = 0; i < inode_cache_len; i++) {
        if (inode_equal(inode_cache[i].key, key)) {
            return &inode_cache[i];
        }
    }
    return NULL;
}

static inode_entry_t *inode_find_by_path(const char *path) {
    for (size_t i = 0; i < inode_cache_len; i++) {
        if (strcmp(inode_cache[i].path, path) == 0) {
            return &inode_cache[i];
        }
    }
    return NULL;
}

static void inode_remove_at(size_t i) {
    free(inode_cache[i].path);
    inode_cache[i] = inode_cache[--inode_cache_len];
}

/* Removes `path` and, if it is a directory, everything below it. */
static void inode_remove_tree(const char *path) {
    for (size_t i = 0; i < inode_cache_len;) {
        if (path_has_prefix(inode_cache[i].path, path)) {
            inode_remove_at(i);
        } else {
            i++;
        }
    }
}

/* Moves every cached entry below `old_dir` to the same place below `new_dir`. */
static void inode_rename_tree(const char *old_dir, const char *new_dir) {
    size_t old_len = strlen(old_dir);

    for (size_t i = 0; i < inode_cache_len; i++) {
        char *path = inode_cache[i].path;
        if (path[old_len] == '/' && strncmp(path, old_dir, old_len) == 0) {
            char updated[PATH_MAX];
            snprintf(updated, sizeof(updated), "%s%s", new_dir, path + old_len);
            free(path);
            inode_cache[i].path = xstrdup(updated);
        }
    }
}

/* Appends without looking for duplicates; only safe while scanning. */
static void inode_append(inode_key_t key, const char *path) {
    if (inode_cache_len == inode_cache_cap) {
        inode_cache_cap = inode_cache_cap ? inode_cache_cap * 2 : 1024;
        inode_cache = xrealloc(inode_cache, inode_cache_cap * sizeof(inode_entry_t));
    }
    inode_cache[inode_cache_len++] = (inode_entry_t){
            .key = key,
            .path = xstrdup(path)
    };
}

static void inode_upsert(inode_key_t key, const char *path) {
    // A path can only hold one inode: drop stale entries (e.g. a file that was
    // replaced by an atomic save).
    for (size_t i = 0; i < inode_cache_len;) {
        if (strcmp(inode_cache[i].path, path) == 0 && !inode_equal(inode_cache[i].key, key)) {
            inode_remove_at(i);
        } else {
            i++;
        }
    }

    inode_entry_t *e = inode_find(key);
    if (e) {
        if (strcmp(e->path, path) != 0) {
            free(e->path);
            e->path = xstrdup(path);
        }
        return;
    }

    inode_append(key, path);
}

static bool get_inode(const char *path, inode_key_t *out, bool *is_dir) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        return false;
    }

    out->dev = st.st_dev;
    out->ino = st.st_ino;
    if (is_dir) {
        *is_dir = S_ISDIR(st.st_mode);
    }
    return true;
}

static void scan_dir(const char *root, bool fresh) {
    if (is_ignored(root)) {
        return;
    }

    DIR *dir = opendir(root);
    if (!dir) return;

    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
        if (!strcmp(ent->d_name, ".") ||
            !strcmp(ent->d_name, ".."))
            continue;

        char path[PATH_MAX];
        snprintf(path, sizeof(path), "%s/%s", root, ent->d_name);
        normalize_slashes(path);

        if (is_ignored(path)) {
            continue;
        }

        bool tracked = is_tracked(path);
        if (!tracked && !contains_tracked(path)) {
            continue;
        }

        struct stat st;
        if (lstat(path, &st) != 0)
            continue;

        if (tracked) {
            inode_key_t key = { st.st_dev, st.st_ino };
            if (fresh) {
                inode_append(key, path);
            } else {
                inode_upsert(key, path);
            }
        }

        if (S_ISDIR(st.st_mode)) {
            scan_dir(path, fresh);
        }
    }

    closedir(dir);
}

static void print_escaped(const char *s, char delim) {
    for (; *s; s++) {
        if (*s == delim || *s == '\\') {
            putchar('\\');
        }
        putchar(*s);
    }
}

static void print_type(FSEventStreamEventFlags flags) {
    if (flags & kFSEventStreamEventFlagItemIsDir) {
        putchar('D');
    } else if (flags & kFSEventStreamEventFlagItemIsSymlink) {
        putchar('S');
    } else {
        putchar('F');
    }
}

static void print_event(const char *events, FSEventStreamEventFlags flags, const char *path, const char *old_path) {
    fputs(events, stdout);
    print_type(flags);
    putchar('|');
    print_escaped(path, '|');
    if (old_path) {
        putchar('|');
        print_escaped(old_path, '|');
    }
    putchar('\n');
}

typedef struct {
    char *path;
    FSEventStreamEventFlags flags;
} vanished_t;

/* Prints START once the stream is known to deliver events. */
static void announce_start(void) {
    if (g_started) {
        return;
    }
    g_started = true;
    if (g_probe_timer) {
        dispatch_source_cancel(g_probe_timer);
    }
    printf("START\n");
    fflush(stdout);
}

/* A new FSEvents stream can drop events for a moment after it starts. To know when it is live, rewrite the
 * root folder's timestamps with their current values: nothing changes on disk, but an event is emitted. */
static void probe_stream(void) {
    struct stat st;
    if (lstat(g_root, &st) != 0) {
        return;
    }
    struct timespec times[2] = { st.st_atimespec, st.st_mtimespec };
    utimensat(AT_FDCWD, g_root, times, AT_SYMLINK_NOFOLLOW);
}

static void event_callback(
    ConstFSEventStreamRef streamRef,
    void *clientCallBackInfo,
    size_t numEvents,
    void *eventPaths,
    const FSEventStreamEventFlags eventFlags[],
    const FSEventStreamEventId eventIds[])
{
    char **paths = eventPaths;

    // Any event proves the stream is live
    announce_start();

    // Paths that were renamed away. FSEvents reports both ends of a rename as
    // separate events, usually in the same batch; whatever is not claimed by
    // the other end of a rename by the end of the batch was moved out of the
    // watched tree (e.g. to the Trash) and is reported as deleted.
    vanished_t *vanished = NULL;
    size_t vanished_len = 0;
    path_list_t claimed = {0};

    for (size_t i = 0; i < numEvents; i++) {
        const char *path = paths[i];
        FSEventStreamEventFlags flags = eventFlags[i];

        // Events on the root itself carry no information (and include our own probes)
        if (is_ignored(path) || strcmp(path, g_root) == 0) {
            continue;
        }

        bool created = flags & kFSEventStreamEventFlagItemCreated;
        bool removed = flags & kFSEventStreamEventFlagItemRemoved;
        bool modified = flags & (kFSEventStreamEventFlagItemModified | kFSEventStreamEventFlagItemInodeMetaMod);
        bool renamed = flags & kFSEventStreamEventFlagItemRenamed;

        inode_key_t key;
        bool is_dir = false;
        bool exists = get_inode(path, &key, &is_dir);
        bool tracked = is_tracked(path);

        if (!exists) {
            // An item created and gone within the same batch was never reported. Only tracked paths are in the
            // cache, so elsewhere we cannot tell and report the deletion anyway.
            if (created && tracked && !inode_find_by_path(path)) {
                continue;
            }
            if (renamed) {
                vanished = xrealloc(vanished, (vanished_len + 1) * sizeof(vanished_t));
                vanished[vanished_len++] = (vanished_t){ .path = xstrdup(path), .flags = flags };
            } else if (removed) {
                print_event("D", flags, path, NULL);
                inode_remove_tree(path);
            }
            continue;
        }

        if (renamed) {
            inode_entry_t *e = tracked ? inode_find(key) : NULL;

            if (e && strcmp(e->path, path) != 0) {
                char *old_path = xstrdup(e->path);
                print_event("R", flags, path, old_path);
                path_list_add(&claimed, old_path);
                inode_upsert(key, path);
                if (is_dir) {
                    inode_rename_tree(old_path, path);
                }
                free(old_path);
                continue;
            }
            if (!e) {
                // Moved in from outside, or moved over an existing item
                bool replaced = inode_find_by_path(path) != NULL;
                print_event(replaced ? "M" : "C", flags, path, NULL);
                if (tracked) {
                    inode_upsert(key, path);
                }
                if (is_dir) {
                    scan_dir(path, false);
                }
                continue;
            }
        }

        if (created || removed || modified) {
            char events[3] = {0};
            size_t n = 0;
            if (created || removed) {
                events[n++] = 'C';
            }
            if (modified) {
                events[n++] = 'M';
            }
            print_event(events, flags, path, NULL);
            if (tracked) {
                inode_upsert(key, path);
            }
            if (is_dir && created) {
                scan_dir(path, false);
            }
        }
    }

    for (size_t i = 0; i < vanished_len; i++) {
        if (!path_list_contains(&claimed, vanished[i].path)) {
            print_event("D", vanished[i].flags, vanished[i].path, NULL);
            inode_remove_tree(vanished[i].path);
        }
        free(vanished[i].path);
    }
    free(vanished);
    path_list_clear(&claimed);
    free(claimed.items);

    fflush(stdout);
}

static void handle_signal(int sig) {
    (void)sig;
    _exit(0);
}

int main(int argc, char *argv[]) {
    if (argc < 2 || argv[1][0] == '-') {
        fprintf(stderr, "Usage: %s <dir> [--ignore <path>]... [--track <path>]...\n", argv[0]);
        return 1;
    }

    char *watch_root = g_root;
    if (!realpath(argv[1], watch_root)) {
        fprintf(stderr, "Cannot watch %s: ", argv[1]);
        perror(NULL);
        return 1;
    }

    for (int i = 2; i < argc; i++) {
        if ((strcmp(argv[i], "--ignore") == 0 || strcmp(argv[i], "--track") == 0) && i + 1 < argc) {
            char resolved[PATH_MAX];
            resolve_path(watch_root, argv[i + 1], resolved);
            path_list_add(strcmp(argv[i], "--ignore") == 0 ? &ignored_paths : &tracked_paths, resolved);
            i++;
        } else {
            fprintf(stderr, "Unknown argument: %s\n", argv[i]);
            return 1;
        }
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    scan_dir(watch_root, true);

    CFStringRef path = CFStringCreateWithCString(
            NULL, watch_root, kCFStringEncodingUTF8
    );

    CFArrayRef paths = CFArrayCreate(
            NULL, (const void **)&path, 1, &kCFTypeArrayCallBacks
    );

    FSEventStreamContext ctx = {0};

    g_stream = FSEventStreamCreate(
            NULL,
            &event_callback,
            &ctx,
            paths,
            kFSEventStreamEventIdSinceNow,
            0.1,
            kFSEventStreamCreateFlagFileEvents
    );

    if (!g_stream) {
        fprintf(stderr, "Failed to create stream\n");
        return 1;
    }

    dispatch_queue_t queue =
            dispatch_queue_create("fsevents.queue", DISPATCH_QUEUE_SERIAL);

    FSEventStreamSetDispatchQueue(g_stream, queue);
    if (!FSEventStreamStart(g_stream)) {
        fprintf(stderr, "Failed to start stream\n");
        return 1;
    }

    // Exit as soon as the parent closes our stdin (or dies)
    dispatch_source_t stdin_source =
            dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, queue);
    dispatch_source_set_event_handler(stdin_source, ^{
        char buffer[256];
        if (read(STDIN_FILENO, buffer, sizeof(buffer)) <= 0) {
            _exit(0);
        }
    });
    dispatch_resume(stdin_source);

    // Probe every 250ms until the stream answers; after 5 seconds, start anyway
    __block int probes = 0;
    g_probe_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(g_probe_timer, dispatch_time(DISPATCH_TIME_NOW, 0), 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(g_probe_timer, ^{
        if (++probes > 20) {
            announce_start();
        } else {
            probe_stream();
        }
    });
    dispatch_resume(g_probe_timer);

    // Blocks forever, handled by GCD
    dispatch_main();

    return 0;
}
