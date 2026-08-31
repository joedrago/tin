# Vendored quickjs-ng

    upstream  https://github.com/quickjs-ng/quickjs
    version   v0.16.2
    tarball   https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.16.2.tar.gz
    sha256    97c80625b26775a4c7ca618c004d4ea24cf99cbf867e4eba78bd927a8b23d106
    license   MIT (LICENSE, alongside this file)

Only what the engine needs to compile is here: four sources — `dtoa.c`,
`libregexp.c`, `libunicode.c`, `quickjs.c` — and the headers they include. The
files are byte-for-byte as they came out of the tarball; the build that uses
them is `../CMakeLists.txt`, not upstream's.

**`quickjs-libc.c` is deliberately absent.** That is the file where quickjs
keeps the `std` and `os` modules — `open`, `write`, `exec`, `getenv`,
`setTimeout`, the whole way down to the machine. It is an optional part of the
engine, off by default upstream (`QJS_BUILD_LIBC=OFF`), and it is not in this
directory, so it is not something a build flag or a later edit can switch back
on by accident. ECMAScript itself defines no I/O, so what is left compiles into
a language with nothing under it.

Also not vendored, because nothing here builds them: the `qjs` and `qjsc`
command-line tools, the test262 runner, the fuzzers, and the examples.

## Updating

Download the new tarball, replace the files listed above, and run the tests. The
list of intrinsics in `../src/tinjs.c` is written out by name on purpose — if a
release adds one, it does not appear in tinjs until somebody adds it there and
says why.
