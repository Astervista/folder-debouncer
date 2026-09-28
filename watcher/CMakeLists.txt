cmake_minimum_required(VERSION 3.20)
project(watcher C)

# Only for IDE builds; `npm run build:watcher` compiles the shipped universal binary
if (EXISTS /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk)
    set(CMAKE_OSX_SYSROOT
            /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk)
endif ()

set(CMAKE_C_STANDARD 11)

add_executable(watcher
        watcher.c)

target_link_libraries(watcher
        "-framework CoreServices")
