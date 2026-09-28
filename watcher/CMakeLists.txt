cmake_minimum_required(VERSION 3.20)
project(watcher C)

set(CMAKE_OSX_SYSROOT
        /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk)

set(CMAKE_C_STANDARD 11)

add_executable(watcher
        watcher.c)

target_link_libraries(watcher
        "-framework CoreServices")
