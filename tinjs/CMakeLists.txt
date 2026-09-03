# tinjs — a JavaScript interpreter that cannot write anything.
#
# The engine is the vendored quickjs-ng in quickjs/, built here rather than
# through its own CMakeLists. That is the point of vendoring it: this file
# compiles four engine sources and one of ours, and there is no target in the
# build for quickjs-libc.c — the std/os bindings that would give a script
# open(), exec() and getenv(). They are not disabled at runtime, they are not
# in the binary.

cmake_minimum_required(VERSION 3.16)
project(tinjs C)

include(CheckCCompilerFlag)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

macro(try_c_flag FLAG)
    string(MAKE_C_IDENTIFIER "HAS${FLAG}" FLAG_VAR)
    check_c_compiler_flag(${FLAG} ${FLAG_VAR})
    if(${FLAG_VAR})
        add_compile_options(${FLAG})
    endif()
endmacro()

# quickjs assumes a char is unsigned and will misparse some inputs if it is not.
# This is the one flag here that is a correctness requirement rather than taste.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "SunOS")
    try_c_flag(-funsigned-char)
endif()

if(MSVC)
    try_c_flag(/experimental:c11atomics)
    add_compile_options(/wd4018 /wd4061 /wd4100 /wd4200 /wd4244 /wd4245 /wd4267
                        /wd4389 /wd4456 /wd4457 /wd4996)
else()
    try_c_flag(-Wall)
    try_c_flag(-Wno-implicit-fallthrough)
    try_c_flag(-Wno-sign-compare)
    try_c_flag(-Wno-unused-parameter)
    try_c_flag(-Wno-unused-but-set-variable)
    try_c_flag(-Wno-array-bounds)
endif()

# quickjs wants an 8MB native stack; Windows gives 1MB (MSVC) or 2MB (MinGW) by
# default, which the JS stack limit alone does not save you from.
if(WIN32)
    if(MSVC)
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /STACK:8388608")
    elseif(CMAKE_C_COMPILER_ID MATCHES "Clang" AND NOT MINGW)
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Xlinker /STACK:8388608")
    else()
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,--stack,8388608")
    endif()
endif()

# The prelude is written as JavaScript so it can be read and linted as
# JavaScript, and turned into a C array here so the binary stays a single file
# with nothing to find at runtime.
set(PRELUDE_JS ${CMAKE_CURRENT_SOURCE_DIR}/src/prelude.js)
set(PRELUDE_H ${CMAKE_CURRENT_BINARY_DIR}/generated/prelude.h)
file(READ ${PRELUDE_JS} PRELUDE_HEX HEX)
string(REGEX REPLACE "(..)" "0x\\1," PRELUDE_BYTES "${PRELUDE_HEX}")
file(WRITE ${PRELUDE_H}
     "/* Generated from src/prelude.js at configure time. Do not edit. */\n"
     "static const char tinjs_prelude[] = {${PRELUDE_BYTES}0x00};\n")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${PRELUDE_JS})

add_library(quickjs STATIC
    quickjs/dtoa.c
    quickjs/libregexp.c
    quickjs/libunicode.c
    quickjs/quickjs.c
)
target_include_directories(quickjs PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/quickjs)
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
if(WIN32)
    target_compile_definitions(quickjs PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
endif()

find_package(Threads)
find_library(M_LIBRARY m)
if(M_LIBRARY)
    target_link_libraries(quickjs PUBLIC ${M_LIBRARY})
endif()
if(CMAKE_THREAD_LIBS_INIT)
    target_link_libraries(quickjs PUBLIC ${CMAKE_THREAD_LIBS_INIT})
endif()
if(CMAKE_DL_LIBS)
    target_link_libraries(quickjs PUBLIC ${CMAKE_DL_LIBS})
endif()

add_executable(tinjs src/tinjs.c)
target_include_directories(tinjs PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)
target_link_libraries(tinjs PRIVATE quickjs)
if(WIN32)
    target_compile_definitions(tinjs PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
else()
    # readBytes()'s offset seeks with fseeko(); without this, off_t is 32 bits on
    # a 32-bit build and a seek past 2GB silently wraps.
    target_compile_definitions(tinjs PRIVATE _FILE_OFFSET_BITS=64)
endif()

install(TARGETS tinjs RUNTIME DESTINATION bin)

enable_testing()

# suite.js is tinjs testing itself: the batteries work, and every name that would
# be a way out of the interpreter is absent. cli.sh covers what a script cannot
# check from inside — exit codes, the limits, and what lands on stderr.
add_test(NAME tinjs-suite
         COMMAND tinjs ${CMAKE_CURRENT_SOURCE_DIR}/test/suite.js
                       ${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures)
if(UNIX)
    add_test(NAME tinjs-cli
             COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/test/cli.sh $<TARGET_FILE:tinjs>)
endif()
