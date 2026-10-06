# Vendored miniz

    upstream  https://github.com/richgel999/miniz
    version   3.1.2
    release   https://github.com/richgel999/miniz/releases/download/3.1.2/miniz-3.1.2.zip
    sha256    f0446d863f9c19926ad9483c523fdc42e42b8d4a6a431d27e09d49c79a140d9a
    license   MIT (LICENSE, alongside this file)

`miniz.c` and `miniz.h` are the release's single-file amalgamation, byte-for-byte
as they came out of the zip. They are what is behind `deflate`, `inflate`,
`gzip`, `gunzip`, `crc32`, `adler32` and `lines()` on a `.gz` file.

The build compiles it with `MINIZ_NO_STDIO`, `MINIZ_NO_TIME` and
`MINIZ_NO_ARCHIVE_APIS` (see `../CMakeLists.txt`). With those set what is left
is the compressor, the decompressor and the two checksums — pure computation
over buffers the caller hands it. Every function in the file that opens, writes
or stats a path is inside the zip-archive code those switches compile out.

## Updating

Download the new release zip, replace the two files, and run the tests.
