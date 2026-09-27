#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>

static FSEventStreamRef g_stream = NULL;

static void handle_signal(int sig) {
    if (g_stream) {
        FSEventStreamStop(g_stream);
        FSEventStreamInvalidate(g_stream);
        FSEventStreamRelease(g_stream);
    }
    exit(0);
}

size_t serial = 0;

static void event_callback(
    ConstFSEventStreamRef streamRef,
    void *clientCallBackInfo,
    size_t numEvents,
    void *eventPaths,
    const FSEventStreamEventFlags eventFlags[],
    const FSEventStreamEventId eventIds[])
{
    char **paths = eventPaths;

    printf("Callback %zu", serial++);

    for (size_t i = 0; i < numEvents; i++) {
        printf("Event %zu\n", i);
        printf("  Path : %s\n", paths[i]);
        printf("  ID   : %llu\n", eventIds[i]);
        printf("  Flags: 0x%08x\n", eventFlags[i]);

        if (eventFlags[i] & kFSEventStreamEventFlagItemCreated)
            printf("    Created\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemRemoved)
            printf("    Removed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemModified)
            printf("    Modified\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemRenamed)
            printf("    Renamed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemInodeMetaMod)
            printf("    Inode metadata changed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemFinderInfoMod)
            printf("    Finder info changed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemChangeOwner)
            printf("    Owner changed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemXattrMod)
            printf("    Extended attributes changed\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemIsFile)
            printf("    Is file\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemIsDir)
            printf("    Is directory\n");
        if (eventFlags[i] & kFSEventStreamEventFlagItemIsSymlink)
            printf("    Is symlink\n");

        printf("\n");
    }
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <dir>\n", argv[0]);
        return 1;
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

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

    // 🔑 This replaces ScheduleWithRunLoop
    dispatch_queue_t queue =
            dispatch_queue_create("fsevents.queue", DISPATCH_QUEUE_SERIAL);

    FSEventStreamSetDispatchQueue(g_stream, queue);
    FSEventStreamStart(g_stream);

    printf("Watching %s\n", argv[1]);

    // Blocks forever, handled by GCD
    dispatch_main();

    return 0;
}
