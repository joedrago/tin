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

    read(path)         file contents as a string
    readBytes(path)    file contents as a Uint8Array
    lines(path)        the file one line at a time, without holding it
    print(...)         a line on stdout
    console.log/error  the same, and its stderr counterpart
    inspect(value)     the string print would have produced
    args               the arguments after the script
    exit(code)         stop now

Reads are unrestricted, the same as everywhere else in tin: it is all your own
machine. `read` decodes UTF-8; `readBytes` returns a copy of the bytes, so writing
into the array it hands back changes nothing on disk.

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

There is deliberately no byte-wise counterpart. `lines` exists because logs and
records are line-oriented; a general streaming API would be a larger surface for
a case that has not come up.

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
tarball.

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
ln -s ~/work/tin/tinjs/build/tinjs ~/tinbin/tinjs
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
    src/tinjs.c        the six hooks, the limits, and the argument handling
    src/prelude.js     console, inspect and the friendly names, in JavaScript
    quickjs/           vendored engine, minus its host bindings
    test/              the two suites and their fixtures

`src/tinjs.c` is the part that has to be audited, so everything that did not have
to be in C is in `src/prelude.js` instead, which the build turns into a C array at
configure time.
