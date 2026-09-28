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

typedef struct {
    dev_t dev;
    ino_t ino;
} inode_key_t;

typedef struct {
    inode_key_t key;
    char *path;
} inode_entry_t;

#define MAX_IGNORES 32

static const char *ignored_paths[MAX_IGNORES];
static size_t ignored_count = 0;

static void add_ignore(const char *root, const char *path) {
    if (ignored_count >= MAX_IGNORES) return;

    char full[PATH_MAX];

    if (path[0] == '/') {
        // absolute
        snprintf(full, sizeof(full), "%s", path);
    } else {
        // relative to watch root
        snprintf(full, sizeof(full), "%s/%s", root, path);
    }

    // Optional but recommended: normalize
    char resolved[PATH_MAX];
    if (realpath(full, resolved)) {
        ignored_paths[ignored_count++] = strdup(resolved);
    }
}

#define INODE_CACHE_SIZE 2048

static inode_entry_t inode_cache[INODE_CACHE_SIZE];
static size_t inode_cache_len = 0;

static FSEventStreamRef g_stream = NULL;

static bool is_ignored(const char *path) {
    for (size_t i = 0; i < ignored_count; i++) {
        const char *ign = ignored_paths[i];
        size_t len = strlen(ign);

        if (strncmp(path, ign, len) == 0 &&
            (path[len] == '/' || path[len] == '\0')) {
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

static void inode_upsert(inode_key_t key, const char *path) {
    inode_entry_t *e = inode_find(key);
    if (e) {
        free(e->path);
        e->path = strdup(path);
        return;
    }

    if (inode_cache_len < INODE_CACHE_SIZE) {
        inode_cache[inode_cache_len++] = (inode_entry_t){
                .key = key,
                .path = strdup(path)
        };
    }
}

static bool get_inode(const char *path, inode_key_t *out) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        return false;
    }

    out->dev = st.st_dev;
    out->ino = st.st_ino;
    return true;
}

static void inode_remove_by_path(const char *path) {
    for (size_t i = 0; i < inode_cache_len; i++) {
        if (strcmp(inode_cache[i].path, path) == 0) {
            free(inode_cache[i].path);
            inode_cache[i] = inode_cache[--inode_cache_len];
            return;
        }
    }
}



static void handle_signal(int sig) {
    if (g_stream) {
        FSEventStreamStop(g_stream);
        FSEventStreamInvalidate(g_stream);
        FSEventStreamRelease(g_stream);
    }
    for (size_t i = 0; i < ignored_count; i++) {
        free(ignored_paths[i]);
    }
    exit(0);
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

static void scan_dir(const char *root) {
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

        struct stat st;
        if (lstat(path, &st) != 0)
            continue;

        inode_key_t key = { st.st_dev, st.st_ino };
        inode_upsert(key, path);

        if (S_ISDIR(st.st_mode)) {
            scan_dir(path);
        }
    }

    closedir(dir);
}



void print_escaped(const char *s, char delim) {
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
    }
    if (flags & kFSEventStreamEventFlagItemIsFile) {
        putchar('F');
    }
    if (flags & kFSEventStreamEventFlagItemIsSymlink) {
        putchar('S');
    }
    if (flags & kFSEventStreamEventFlagItemIsHardlink) {
        putchar('H');
    }
    if (flags & kFSEventStreamEventFlagItemIsLastHardlink) {
        putchar('L');
    }
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

    for (size_t i = 0; i < numEvents; i++) {

        if (is_ignored(paths[i])) {
            continue;
        }

        bool created = eventFlags[i] & kFSEventStreamEventFlagItemCreated;
        bool removed = eventFlags[i] & kFSEventStreamEventFlagItemRemoved;
        bool modified = eventFlags[i] & kFSEventStreamEventFlagItemModified;
        bool renamed = eventFlags[i] & kFSEventStreamEventFlagItemRenamed;
        bool touched = eventFlags[i] & kFSEventStreamEventFlagItemInodeMetaMod;

        if (created || modified || touched) {
            if (created) {
                putchar('C');
            }
            if (modified | touched) {
                putchar('M');
            }
            print_type(eventFlags[i]);
            putchar('|');
            print_escaped(paths[i], '|');
            putchar('\n');
            inode_key_t key;
            if (get_inode(paths[i], &key)) {
                inode_upsert(key, paths[i]);
            }
            fflush(stdout);
        }
        if (renamed) {
            inode_key_t key;

            if (get_inode(paths[i], &key)) {
                inode_entry_t *e = inode_find(key);

                if (e) {
                    // OLD -> NEW rename
                    putchar('R');
                    print_type(eventFlags[i]);
                    putchar('|');
                    print_escaped(paths[i], '|');   // old
                    putchar('|');
                    print_escaped(e->path, '|');  // new
                    putchar('\n');
                } else {
                    // First time seeing this inode
                    putchar('C');
                    print_type(eventFlags[i]);
                    putchar('|');
                    print_escaped(paths[i], '|');
                    putchar('\n');
                }

                inode_upsert(key, paths[i]);
                fflush(stdout);
            }
            continue;
        }
        if (removed) {
            putchar('D');
            print_type(eventFlags[i]);
            putchar('|');
            print_escaped(paths[i], '|');
            putchar('\n');
            inode_remove_by_path(paths[i]);
            fflush(stdout);
        }
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <dir>\n", argv[0]);
        return 1;
    }

    const char *watch_root = argv[1];

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--ignore") == 0 && i + 1 < argc) {
            char *list = strdup(argv[++i]);  // safe copy
            char *save = NULL;

            for (char *tok = strtok_r(list, ",", &save);
                 tok;
                 tok = strtok_r(NULL, ",", &save)) {

                add_ignore(watch_root, tok);
            }

            free(list);
        }
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    scan_dir(argv[1]);

    CFStringRef path = CFStringCreateWithCString(
            NULL, argv[1], kCFStringEncodingUTF8
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
    FSEventStreamStart(g_stream);


    printf("START\n");
    fflush(stdout);

    // Blocks forever, handled by GCD
    dispatch_main();

    return 0;
}
