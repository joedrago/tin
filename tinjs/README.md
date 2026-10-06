# tinjs

**A JavaScript interpreter with nothing underneath it.**

A model working under tin has no shell, which is the point, and it also has no way
to write the small throwaway script that most data work actually wants — parse
this log, group those records, pull the versions out of that lockfile. Linking a
real interpreter back in would hand back general code execution and undo the whole
arrangement; `python`, `node` and `perl` are on tin's list of things not to link
for exactly that reason.

tinjs is the middle ground: a real language with real batteries, and no way to
reach the machine from inside it.

```sh
tinjs -e 'print(JSON.parse(read("package.json")).version)'
tinjs summarise.js access.log
```

## What is in it

Standard JavaScript, essentially all of it. The engine is
[quickjs-ng](https://github.com/quickjs-ng/quickjs), so that means ES2023: regular
expressions with named groups, lookbehind and unicode property escapes; `JSON`;
`Map`, `Set`, `WeakMap`; typed arrays; `Date`; `BigInt`; classes with private
fields; generators; destructuring; `async`/`await`; `atob`/`btoa`. Every global is
either ECMAScript or one of the ones below.

    read(path)                       file contents as a string
    readBytes(path)                  file contents as a Uint8Array
    readBytes(path, offset, length)  length bytes starting at offset
    stat(path)                       { size, mtime, isDirectory, isFile, isSymlink }
    readdir(path)                    [{ name, isDirectory, isFile, isSymlink }], sorted
    walk(path)                       every entry below path, depth-first, as { path, ... }
    readlink(path)                   where a symlink points, unresolved
    lines(path)                      the file one line at a time, without holding it
    print(...)                       a line on stdout
    console.log/error                the same, and its stderr counterpart
    inspect(value)                   the string print would have produced
    args                             the arguments after the script
    exit(code)                       stop now

And a handful that only compute — a value in, a value out, nothing touched:

    gzip(data, level) / gunzip(data)       .gz files
    deflate(data, level) / inflate(data)   zlib streams
    deflateRaw / inflateRaw                bare deflate, as inside a zip entry
    unxz(data)                             .xz files (decompress only)
    md5(data), sha1(data), sha256(data)    hashes, as lowercase hex
    crc32(data), adler32(data)             checksums, as numbers
    TextEncoder, TextDecoder               utf-8; utf-16le/be and latin1 to decode

`data` is a string (taken as UTF-8), an `ArrayBuffer`, or any typed array; the
compressors return a `Uint8Array`. `level` is zlib's 0–9, 6 by default.

A few habits from Node are caught rather than left to go quietly wrong. The
decompressors refuse a string, because one is almost always `read()` where
`readBytes()` was meant, and `read()` has already mangled the bytes. A level
that is not a whole number from 0 to 9 throws, so a Node-style callback in its
place is an error instead of level 0 and a callback that never runs. And
everything returns a `Uint8Array` rather than a Node `Buffer`, so `.toString()`
gives comma-separated numbers: text comes from `new TextDecoder().decode(bytes)`.
`inspect` and `print` show the first 100 items of an array and summarise the
rest, so printing a decompressed file by mistake costs a few lines rather than
a line per byte.

Reads are unrestricted, the same as everywhere else in tin: it is all your own
machine. `read` decodes UTF-8; `readBytes` returns a copy of the bytes, so writing
into the array it hands back changes nothing on disk.

### Slicing a file that does not fit, and knowing what you are looking at first

`readBytes(path)` is `read`'s problem too — the whole file, in memory — which
matters most for exactly the files it is for: binary formats, where `read`'s
UTF-8 decoding would corrupt the bytes anyway. `readBytes(path, offset, length)`
is the way around it, a slice with no need to hold what surrounds it:

```js
const magic = readBytes("archive.tar", 257, 8); // ustar\0 at the header's usual spot
```

`offset` alone reads from there to the end of the file; both omitted is the
whole-file form from before. Asking past the end of the file is not an error —
a short or empty result is what you get, the same as a short `fread()` — but a
negative `offset` or `length` throws, since neither one is a real position.

`stat(path)` answers the questions worth asking before any of that: how big
the file is, when it last changed, and whether it is a file at all rather than
a directory you just handed to `read`.

```js
const info = stat("access.log");
if (info.isFile && info.size > 100 << 20) {
    // too big to read() — walk it with lines() instead
}
```

`size` is bytes, `mtime` is a `Date`, and `isDirectory`/`isFile` are exactly one
of them `true` for anything `stat` can see at all — it throws instead for a path
that does not exist, the same as `read` does.

### Finding the files in the first place

`readdir(path)` lists one directory; `walk(path)` is every entry below it, a
generator so a tree of any size is not held at once:

```js
let total = 0;
for (const e of walk("logs")) {
    if (e.isFile && e.path.endsWith(".log")) total += stat(e.path).size;
}
```

Both are sorted by name, so two runs over the same tree print the same thing.
`isFile` and `isDirectory` describe what a symlink points at, and a link that
points at nothing is neither. `walk` reports a symlinked directory without
entering it, which is what keeps a link back up the tree from being a loop, and
it skips the contents of a subdirectory it cannot list rather than giving up on
the whole walk. `readlink` throws on Windows, where there is no plain
equivalent.

### Walking a file that does not fit

`read` wants the whole file in memory, which stops being reasonable somewhere
around the log you actually wanted to grep. `lines` is the same read taken one
line at a time:

```js
let errors = 0;
for (const line of lines("access.log")) {
    if (line.includes(" 500 ")) errors++;
}
print(errors);
```

At any moment that holds one line and a small window of the file, whatever the
file's size — a million lines is a fraction of a second, and the memory limit
never comes into it.

Each call opens the file and returns its own iterator, so two walks of the same
path have their own positions and cannot disturb each other. There is no rewind
and no seek: starting again from the top is calling `lines` again. The file is
closed when the last line has been read and when a loop is left early — `break`,
`return` and `throw` all reach it through the iterator protocol — and an
iterator that is simply dropped is closed when it is collected, at the latest
when the process exits.

Terminators are not part of what you get: `\n` is stripped, and so is the `\r`
in front of it, so a file with CRLF endings reads the same as one without. A
last line with no newline after it is still a line, and blank lines come back as
empty strings rather than being skipped.

A file that begins with gzip's or xz's magic bytes is decompressed on the way
in, so `lines("access.log.1.gz")` is the same loop as on the live log, in the
same constant memory (plus xz's dictionary, which is 8 MB for a default `xz`
file and 64 MB for `xz -9`). Concatenated files are followed through, every
checksum is checked, and a truncated or corrupt file throws partway through rather than
quietly ending early.

There is deliberately no byte-wise counterpart. `lines` exists because logs and
records are line-oriented; a general streaming API would be a larger surface for
a case that has not come up.

### Compressed data, hashes and text

The compression functions are zlib's, with Node's names: `gzip`/`gunzip` for
`.gz` files, `deflate`/`inflate` for the zlib-wrapped stream that HTTP, PNG and
git objects use, and the `Raw` pair for a bare stream such as a zip entry
holds. `unxz` reads `.xz` — every integrity check and BCJ filter, and
concatenated streams — but there is no `xz` to go with it: the decoder
vendored for it has no encoder, and reading is the case that comes up. With
`readBytes` slices that is enough to read inside an archive without
unpacking it, which tinjs could not do anyway.

```js
const head = new TextDecoder().decode(gunzip(readBytes("dump.json.gz"))).slice(0, 200);
print(sha256(readBytes("release.tar.gz")));
```

Decompression stops at the same 512 MB ceiling as `read`, so a small file that
claims to expand to terabytes is an error rather than an allocation. Corrupt
input and checksum mismatches throw.

`TextDecoder` decodes UTF-8, UTF-16 in either byte order, and `latin1` — which,
as on the web, means windows-1252. A leading byte-order mark is dropped unless
`ignoreBOM` is set, and malformed input becomes U+FFFD unless `fatal` is set, in
which case it throws.

## What is not in it

There is no way to create or modify a file, open a socket, start a process, read
an environment variable, load a module, or sleep. Not a flag that turns those off
— no function that does them, and no library behind them to call.

That is a property of the build rather than a policy applied at runtime. quickjs
keeps its host bindings in one optional file, `quickjs-libc.c`, and that file is
where `open`, `write`, `exec`, `getenv` and `setTimeout` live. It is not vendored
and it is not compiled. ECMAScript itself defines no I/O at all, so once it is
gone there is nothing left to deny: the usual escapes have nothing to reach.

    tinjs -e 'std.open("/tmp/x", "w")'     ReferenceError: std is not defined
    tinjs -e 'os.exec(["/bin/sh"])'        ReferenceError: os is not defined
    tinjs -e 'require("fs")'               ReferenceError: require is not defined
    tinjs -e '[].constructor.constructor("return process")()'
                                           ReferenceError: process is not defined

The intrinsics that *are* present are named one at a time in `src/tinjs.c` rather
than taken from `JS_NewContext`, so an engine update that adds a new one does not
add it here until somebody says so.

There are no modules either — one script, no `import`, no `require`. Nothing to
resolve means nothing to resolve *from*.

## Getting results out

stdout is the only channel. A script prints what it worked out, tin's `tin_run`
hands that back, and anything that needs to land on disk is written by tin's own
write tool, under the write-root check like every other write.

tin's `capture` puts that stdout in a file rather than in the reply, which is how
one command's output becomes the next one's input. It changes nothing here: the
path is tin's choice, not the script's, and a script that prints has no idea
whether anything is catching it. tinjs still cannot name a destination, because
it still has no call that names one.

This is deliberate, and it is why tinjs is safe to link even though a general
interpreter is not. tinjs is not trusted to respect the write roots — it is
incapable of writing at all, so the question never arises. It stays true no matter
what the model puts in the script.

## Limits

There is no time or memory limit by default. Under tin, `exec.timeoutMs` is
already the outer bound on every command, and a second, shorter one that only
tinjs has is a thing to decide on purpose rather than inherit — so the defaults
are commented out in `src/tinjs.c` rather than deleted, waiting on that decision.

Both are still implemented, and still there when you want them:

```sh
tinjs --timeout 30 --memory 512 summarise.js big.log
```

The timeout reaches into the regular expression engine too, so catastrophic
backtracking is stopped rather than merely regretted.

Two bounds are not part of that pair and stay on, because neither is a policy so
much as a way of failing legibly: the JS stack limit, so deep recursion raises a
`RangeError` instead of running off the native stack, and a 512 MB ceiling on a
single `read`, which covers a malloc that the JS heap limit would not have. That
same ceiling applies to one line from `lines`: a "line" that long is a file with
no newlines in it, which is the case `read` already refuses, and the two failing
at the same size is one number to remember instead of two.

## Building

No dependencies, no network, nothing to install. The engine is vendored in
[`quickjs/`](quickjs/VENDORED.md) — four C files, byte-for-byte from the upstream
tarball — compression in [`miniz/`](miniz/VENDORED.md), one more, built with its
file and zip-archive code compiled out, and the `.xz` decoder in
[`xz/`](xz/VENDORED.md), a few more with nothing to compile out.

```sh
cmake -S tinjs -B tinjs/build
cmake --build tinjs/build --config Release
ctest --test-dir tinjs/build -C Release --output-on-failure
```

The `--config`/`-C` pair is what makes that Release everywhere. Single-config
generators — Ninja, Makefiles — take the build type at configure time and this
file already defaults them to Release, so they ignore both flags. Multi-config
generators, which is what you get by default on Windows, decide per build
instead: without `--config` they build Debug, and `ctest` will not run at all
without a matching `-C` ("Test not available without configuration").

That is a ~1 MB single-file binary with no runtime of its own to find. Then link
it in like anything else:

```sh
ln -s /path/to/tin/tinjs/build/tinjs ~/tinbin/tinjs
```

On Windows the entry needs its extension, because that is the name the model
calls, and the multi-config generator puts the binary in a subdirectory named
for the configuration:

```bat
mklink %USERPROFILE%\tinbin\tinjs.exe C:\work\tin\tinjs\build\Release\tinjs.exe
```

tin notices it by name and tells the model what it is, so there is nothing to
configure.

## Tests

`test/suite.js` is tinjs testing itself, and it checks two things: that the
batteries work, and that every global which would mean a way out is absent — so a
version bump that quietly restores one fails the build. `test/cli.sh` covers what
a script cannot see from inside itself: exit codes, the limits, and stderr.

## Layout

    CMakeLists.txt     builds the engine and one executable, and nothing else
    src/tinjs.c        the hooks, the limits, and the argument handling
    src/digest.c       MD5, SHA-1 and SHA-256, pure computation
    src/prelude.js     console, inspect and the friendly names, in JavaScript
    quickjs/           vendored engine, minus its host bindings
    miniz/             vendored deflate/inflate, minus its file and zip code
    xz/                vendored XZ Embedded, the .xz decoder
    test/              the two suites and their fixtures

`src/tinjs.c` is the part that has to be audited, so everything that did not have
to be in C is in `src/prelude.js` instead, which the build turns into a C array at
configure time.
