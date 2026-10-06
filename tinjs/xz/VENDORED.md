# Vendored XZ Embedded

    upstream  https://github.com/tukaani-project/xz-embedded
    version   v2024-12-30
    tarball   https://github.com/tukaani-project/xz-embedded/archive/refs/tags/v2024-12-30.tar.gz
    sha256    ee12fa8c49c9c0ef4a144af4234d2530d786c1ce14247a7d5fc92a946628977d
    license   0BSD (COPYING, alongside this file)

The decoder half of xz, and nothing else: it is what is behind `unxz` and
`lines()` on a `.xz` file. There is no encoder in XZ Embedded at all.

The files are byte-for-byte from the tarball, flattened into one directory:
`xz.h` from `linux/include/linux/`, `xz_config.h` from `userspace/`, and the
rest from `linux/lib/xz/`. Every one of them includes only `<stdbool.h>`,
`<stdlib.h>`, `<string.h>`, `<stddef.h>` and `<stdint.h>`; the decoder works
on buffers the caller hands it and has no file, process or network code to
leave out.

Not vendored: the userspace test programs, the kernel glue
(`decompress_unxz.c`, `xz_dec_syms.c`, `xz_dec_test.c`) and the build files.
`../CMakeLists.txt` sets the configuration the upstream `userspace/Makefile`
uses — every BCJ filter, CRC64, SHA-256, any check, concatenated streams.

This is a separate project from xz-utils, where the 2024 backdoor was; that was
in xz-utils' release-tarball build scripts and test files. The source here was
read before it was vendored, and is worth reading again on an update.

## Updating

Download the new tarball, replace the files listed above, read the diff, and
run the tests.
