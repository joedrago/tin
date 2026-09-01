# tin

**The best way to contain your pi is in a tin.**

tin is an extension for [pi](https://pi.dev) that replaces its capability set with a much
smaller one, so you can point a local model at a directory and walk away.

| | |
|---|---|
| **Read** | Anywhere. `read`, `ls`, `grep` and `find` are untouched — it is all your own machine. |
| **Write** | Only inside the workspace. Symlinks are resolved first, so a link out of the tree is not a way out. |
| **Execute** | Only what you have symlinked into `~/tinbin`, run directly with an argument array. There is no shell. |
| **Everything else** | Denied. Tools tin does not recognize — including ones a future pi version adds — are unavailable until you say otherwise. |

`bash` and `powershell` are not gated, they are gone: the model never sees them in its tool
list. In their place is `tin_run`, which takes a command name and an array of arguments and
execs it with no shell in between. Nothing is expanded — no pipes, no `>`, no globs, no
`$(...)` — so redirection cannot be used to write where the write gate would have said no.

Output still has to reach the next command somehow, and [capture](#capturing-output) is how:
tin writes the command's stdout to a file of its own choosing and hands back the path. The
model never names the destination, so this stays true — there is no `>` to point anywhere.

## Install

```sh
# -------------------------------------------------------------------------
# Required stuff

# Choose your own value of TIN_ROOT here!
export TIN_ROOT=/path/to/tin

# Clone + basic functionality
git clone https://github.com/joedrago/tin.git ${TIN_ROOT}
ln -s ${TIN_ROOT}/src ~/.pi/agent/extensions/tin

# -------------------------------------------------------------------------
# Optional stuff

# "tin" frontend wrapper for pi for adding more RW roots
ln -s ${TIN_ROOT}/bin/tin ~/bin/tin

# grant access to jq, readonly wrappers for git/rg
mkdir -p ~/tinbin
ln -s ${TIN_ROOT}/wrappers/rg  ~/tinbin/rg    # not the real rg; see below
ln -s ${TIN_ROOT}/wrappers/git ~/tinbin/git   # nor the real git
ln -s "$(command -v jq)"       ~/tinbin/jq

# tinjs (safe Javascript support)
cmake -S ${TIN_ROOT}/tinjs -B ${TIN_ROOT}/tinjs/build
cmake --build ${TIN_ROOT}/tinjs/build --config Release
ln -s ${TIN_ROOT}/tinjs/build/tinjs ~/tinbin/tinjs
```

## Extra write roots for one session

The workspace is the only writable directory, which is the point, right up until the job
genuinely spans two of them. `bin/tin` starts pi with the directories you name added to
the write roots for that session and no longer:

```sh
ln -s /path/to/tin/bin/tin ~/bin/tin

tin                     # exactly a plain pi: the working directory and nothing else
tin ../shared ~/notes   # those two as well, until you close the session
tin -r ../shared        # the same, picking a session to resume
```

Order does not matter, `-r` is handed to pi, and anything else beginning with `-` is
refused rather than quietly forwarded. A directory that does not exist is an error from
the shell you are still looking at, not a warning inside a session you have already
started.

tin prints the roots it ended up with as the session opens, with the temporary ones
marked, because a root you granted on a command line an hour ago is exactly the kind of
thing worth being reminded of:

```
tin: writable directories
  /home/you/work/thing
  /home/you/notes  (this session only)
```

`/tin` shows them too, and says which of them came from the environment. The wrapper
resolves nothing relative to itself, so a symlink onto your `PATH` is the whole
installation.

## Allowing commands

Create the directory and link in exactly what you are willing to let the model run:

```sh
mkdir -p ~/tinbin
ln -s /path/to/tin/wrappers/rg  ~/tinbin/rg    # not the real rg; see below
ln -s /path/to/tin/wrappers/git ~/tinbin/git   # nor the real git
ln -s "$(command -v jq)"      ~/tinbin/jq
```

The model can then call them:

```
tin_run { command: "rg", args: ["-n", "TODO", "src"] }
tin_run { command: "git", args: ["status", "--short"] }
```

`/tin` prints the policy in force: config path, write roots, protected paths, and the
commands currently linked. If `~/tinbin` is empty, nothing can be executed at all, which is
a perfectly reasonable way to run.

Adding and removing links takes effect immediately — no restart, no reload.

**Choose these carefully.** The allowlist is the whole security model for execution. Linking
`bash`, `sh`, `python`, `node`, `perl`, `make`, `npm`, `docker` or `env` hands back general
code execution, and with it the ability to write anywhere you can write. `find` will run
arbitrary programs through `-exec`. `git` can run hooks and pagers.

The ones that catch people out are the tools that look inert and are not. `sed` writes an
arbitrary path with its `w` command and edits in place with `-i`; `awk` has `system()` and
`print > "file"`; `sort` has `-o`; `fd` has `-x`; even `rg`, which has no way to write a
file at all, will run a program of your choosing through `--pre`. Read the manual page
adversarially before you link something, and prefer a narrow tool, or a small wrapper in
`~/tinbin` that pins what you actually want — [`wrappers/`](wrappers) has a read-only `git`
and a `rg` with its two exec flags closed, either of which you can link instead of the real
thing.

Genuinely inert, for a starting point: `jq`, `grep`, `wc`, `cut`, `tr`, `uniq`, `comm`,
`diff`, `strings`, `xxd`, `base64`, `head`, `tail`, `file`, `stat`. None of them has a flag
that writes a file or starts a program.

If what you wanted from `python` or `node` was a scratch script to chew on some data,
[`tinjs`](#tinjs) is that without the general code execution.

## Writing a wrapper

Linking a binary gives away everything that binary can do. Often what you actually want
to hand over is one capability, which means a small script in `~/tinbin` that pins the
dangerous parts and passes the rest through. A few things are worth knowing before you
write one:

- **`PATH` is the allowlist directory.** Your script cannot call `grep`, `sed`, `cut` or
  `cat` — they are not on it. Use shell builtins, and call the real tool by absolute
  path.
- **Pin credentials and targets, and refuse the flags that change them.** Reads are
  unrestricted, so a model can find the passwords in your config files. A wrapper that
  pins a low-privilege account is only worth something if it also refuses the flag that
  would swap that account back out.
- **Check what the tool itself can be talked into.** Plenty of ordinary programs will
  write an arbitrary file or run a shell command if you pass the right option — logging,
  debug, pager and plugin-path flags are the usual suspects. Read the manual page
  adversarially and turn off the feature at the source when you can.
- **Allowlist short options rather than denying them.** They cluster, so a check for
  `-u` never sees the one hiding in `-Nuvalue`.
- **Push the real guarantee downwards.** If the underlying system can enforce what you
  want — a read-only account, a restricted token — let it. The wrapper's job is then
  only to protect the credential, which is a much smaller thing to get right.

## Ready-made wrappers

`wrappers/` holds wrappers general enough to be worth sharing. Nothing in it is active
until you link one in — tin never looks at that directory itself, only at `binDir`:

```sh
ln -s /path/to/tin/wrappers/git ~/tinbin/git
```

They are POSIX shell scripts with no dependencies beyond the tool they wrap, written to
the rules above: because `PATH` is the allowlist directory, each calls the real binary by
absolute path, chosen from a short list of the usual locations at the top of the script.
Edit that list if yours lives somewhere else. Read the one you link before you link it —
you are the one who ends up trusting it.

Windows has no `/bin/sh`, so a wrapper that is worth having there is written for Node
instead and named `.mjs` — see [Windows](#windows) below. `git` and `git.mjs` are the
same policy in two languages, which means a rule added to one is missing from the other
until it is added there too. `test/wrapper-git.test.ts` covers the Node one.

### `git` — read-only git

An allowlist of subcommands that only inspect a repository: `log`, `diff`, `show`,
`status`, `grep`, `blame`, `rev-parse`, `ls-files`, `cat-file` and friends. Everything
that writes objects, refs, the index, the working tree or the config is refused, and so
is everything that touches the network. `branch` and `tag` are pinned to `--list` and
`reflog` to `show`, which puts their destructive modes out of reach; `stash` is limited
to `list` and `show`, `worktree` to `list`, `remote` to `remote -v`.

The rest of the script is about the options, because git has a lot of ways to turn a read
into an exec:

- **Top-level options are refused outright.** `-c` sets any config key — a pager, an
  alias, an external diff — and `--exec-path`, `--git-dir` and `--config-env` are no
  better. Use `tin_run`'s `cwd` instead of `git -C`.
- **Options that name a file to write or a program to run are refused**, including
  through abbreviations. Git expands any unambiguous prefix, so `--open-f=/bin/sh`
  really does reach `--open-files-in-pager`; the check compares prefixes in both
  directions rather than matching names.
- **Short options may not bundle a value**, since `-Sfoo` and the cluster `-vO` are the
  same shape. Write `-S foo`. Every letter has to be safe on its own, which is all of
  them except `-o` and `-O`.
- **The config keys that run programs are overridden on every call** — pager, editor,
  `diff.external`, `core.fsmonitor`, `gpg.program`, hooks path — so a repository that
  sets one does not get to use it. `--no-optional-locks` keeps a plain `status` from
  rewriting the index, so the read stays a read.

### `rg` — ripgrep without its exec flags

Much shorter than the git one, because ripgrep is very nearly inert already: it has no
flag that writes a file, and everything it produces goes to stdout. What it has is two
flags that hand it a program, and the wrapper is mostly those:

- **`--pre` and `--hostname-bin` are refused**, and `--pre-glob` with them, since it
  exists only to steer the first. `--pre` runs a command of your choosing on every file
  before searching it, which is general code execution wearing a search flag.
- **`--no-config` is passed on every call**, and `RIPGREP_CONFIG_PATH` is unset. A config
  file can contain `--pre` as easily as a command line can. tin does not carry that
  variable into a child anyway, but a wrapper that is only correct because of something
  another file does is a wrapper that breaks quietly when that file changes.
- **Everything after `--` is left alone**, so a pattern that looks like a flag is still
  searchable. Before it, an argument that merely resembles one of the refused flags is
  refused rather than reasoned about.

`-z`/`--search-zip` is deliberately left working. It runs a decompressor, but only one it
can find on `PATH`, and `PATH` inside tin is the allowlist directory — so it reaches a
decompressor exactly when you have linked one, which is a decision you already made.

`test/wrapper-rg.test.ts` covers the Node one.

## tinjs

Models reach for a throwaway script constantly — parse this log, group those records,
pull the versions out of that lockfile — and under tin there is nothing to reach for.
A real interpreter would hand back general code execution, which is the one thing the
allowlist exists to prevent.

[`tinjs/`](tinjs) is the way out of that trade: a JavaScript interpreter built so that
it cannot write. Standard ES2023 is all there — regular expressions with named groups
and lookbehind, `JSON`, `Map`, `Set`, typed arrays, `Date`, `BigInt`, classes,
`async`/`await` — plus `read`, `readBytes`, `lines`, `print`, `console`, `inspect`,
`args` and `exit`. Nothing else. There is no function that creates a file, opens a
socket, starts a process, reads the environment or loads a module, because the engine's
host bindings are not compiled into the binary at all.

Building it and linking it into `tinbin` is [its own README](tinjs/README.md#building).
Once it is there:

```
tin_run { command: "tinjs", args: ["-e", "print(JSON.parse(read('package.json')).version)"] }
```

`read` wants the whole file in memory, which stops being reasonable around the size of
the log you actually wanted to search. `lines` is the same read one line at a time, and
holds only the line it is on:

```
tin_run { command: "tinjs", args: ["-e",
  "let n=0; for (const l of lines(args[0])) if (l.includes(' ERROR ')) n++; print(n)",
  "access.log"] }
```

Results come back on stdout and nowhere else, so a script prints what it worked out and
tin's own write tool puts it on disk under the usual check. That is what makes tinjs
safe to link when `node` is not: it is not trusted to respect the write roots, it is
incapable of writing, whatever ends up in the script.

tin recognises the name and tells the model what it is, so linking it is the whole
setup. [`tinjs/README.md`](tinjs/README.md) has the rest — the limits, what the build
leaves out and why, and how the vendored engine is updated.

## Capturing output

There is no shell, so there is no `|` and no `>`, and for a long time that meant the only
way one command's output reached another was through the conversation: the model read it,
retyped it into a file, and read it back. That works for twenty lines and fails for
twenty thousand, both on cost and because a model retyping a large payload verbatim gets
it subtly wrong.

`capture` is the way across. Ask for it and the command's stdout goes to a file instead
of coming back whole:

```
tin_run { command: "rg", args: ["--json", "TODO", "src"], capture: true }
```

```
rg --json TODO src exited with code 0

stdout was captured to /tmp/tin-4f9a.../1-rg.out (47.2 MB, 310204 lines)

first 30 lines:
...
```

The path is what the model does something with — usually hands it straight to the next
command, which is where `tinjs`'s `lines` comes in, since the whole file never has to fit
anywhere:

```
tin_run { command: "tinjs", args: ["summarise.js", "/tmp/tin-4f9a.../1-rg.out"] }
```

What comes back from a captured run is the shape of the file and its first thirty lines,
which is enough to see that the command did what was wanted — that it matched something,
that the output is JSON and not an error page — without paying for the rest of it.

Some details that matter:

- **tin chooses the path, not the model.** That is what keeps this from being redirection
  by another name: nothing in the call names a destination, so it cannot be pointed at
  `~/.ssh/authorized_keys`. The directory is created under the OS temp directory on the
  first capture of a session, with a fresh random name, and it is never writable — it is
  on the same list as tin's own config and the allowlist directory.
- **stderr is not in the file.** It comes back in the result as it always has. A capture
  file is data for another program to read, and a warning interleaved into it corrupts
  that quietly; a warning in the result is in front of you instead.
- **tin never deletes a capture file.** A path handed out an hour ago should still work
  an hour later, so cleanup is the operating system's job, the way it is for everything
  else in the temp directory. `/tin` prints the directory when you want to look, or to
  clear it out yourself.
- **`exec.maxCaptureBytes` is the only bound**, and it is set at 4 GB — high enough that
  it is a backstop against a runaway rather than a limit you work around. In practice
  `exec.timeoutMs` stops most things long before it.

## Windows

The allowlist directory is `%USERPROFILE%\tinbin`, and everything above still holds, but
what you can put in it is narrower:

- **Link the file, extension and all.** `mklink %USERPROFILE%\tinbin\rg.exe C:\path\to\rg.exe`
  wants Developer Mode on or an elevated prompt; copying the file in works just as well
  if neither is convenient. The name in the directory is the name the model calls, so
  this one is `rg.exe`, not `rg`.
- **An entry with no extension will not run.** Windows starts an image, not a shebang
  line, so a POSIX script named `git` is not something it can launch. Wrappers meant for
  Windows carry an extension, and the model calls them by it.
- **`.mjs`, `.cjs` and `.js` entries run under Node**, started with the same node pi is
  running on, so there is nothing to find or install. Arguments go straight into `argv`
  with no shell and no cmd in between, and node reads none of its own options out of
  them. This is the good way to write a wrapper with a policy in it: `wrappers/git.mjs`
  is the read-only git policy in a language that can express it.
- **`.bat` and `.cmd` entries are launched through `cmd /d /s /c`**, because they are not
  images either and Node refuses to spawn one without a shell. Arguments are escaped for
  both of cmd's parses on the way in, so `& | < > ^ %` quotes and backslashes reach the
  program verbatim — the model still gets an argument array, not a shell. `/d` skips
  whatever `AutoRun` is set in the registry. Prefer `.mjs` unless you specifically need
  cmd.
- **There is no executable bit.** Every file reads as executable on Windows, so being in
  the directory at all is the whole allowlist decision. Keep data files out of it.

So the read-only git looks like this, and the model calls it as `git.mjs`:

```bat
mklink %USERPROFILE%\tinbin\git.mjs C:\work\tin\wrappers\git.mjs
```

A link points at the file it was made from, so linking a wrapper straight out of this
repo means editing the repo edits the allowlisted command. That is usually what you want.

It is also safe, and for the ordinary reason rather than a special one. A session's write
roots are the directory you pointed it at; this repository is not one of them and neither
is the allowlist directory, so there is nothing a model under tin can do to reach either
end of the link. It cannot edit the wrapper, and it cannot replace the entry pointing
at it.

## Configuration

Optional, at `~/.pi/agent/tin.json`. Every field has a strict default, and a malformed file
falls back to those defaults rather than to something more permissive.

```json
{
  "binDir": "~/tinbin",
  "writeRoots": ["."],
  "denySegments": [".git", ".pi", ".agents"],
  "allowTools": [],
  "exec": {
    "timeoutMs": 120000,
    "maxOutputBytes": 100000,
    "maxOutputLines": 2000,
    "maxCaptureBytes": 4294967296,
    "passEnv": ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"],
    "env": {}
  }
}
```

- **`binDir`** — where allowed commands are linked from. It must live outside every write
  root; if it does not, tin disables execution entirely and says so, because an allowlist
  the model can add to is not an allowlist.
- **`writeRoots`** — directories the model may write into. Defaults to the session's working
  directory. Setting this *replaces* the default rather than adding to it.
- **`denySegments`** — path segments that stay read-only at any depth inside a write root.
  The defaults are the ones that grant code execution or rewrite the agent's own
  configuration: `.git` (hooks), `.pi` (project extensions and settings), `.agents` (skills).
- **`allowTools`** — extra tool names to let through the gate, for tools from other
  extensions you trust.
- **`exec.maxCaptureBytes`** — the ceiling on one [capture](#capturing-output) file. A
  different kind of limit from `maxOutputBytes` and `maxOutputLines` above it: those keep
  a command's output from swamping the conversation, this one only keeps a runaway from
  filling the disk, so it is set where a mistake is still caught and a real log is not.

One setting also has an environment variable, `TIN_EXTRA_WRITE_ROOTS`: a delimiter-separated
list of directories, in the shape of `PATH`, *added* to whatever `writeRoots` resolved to
rather than replacing it. This is what [`bin/tin`](#extra-write-roots-for-one-session) sets,
and setting it yourself does the same thing. It is read once, at session start, from pi's own
environment — somewhere the model cannot reach, since `tin_run` builds its children an
environment from scratch and never passes this one on. The roots it names are checked exactly
as configured roots are, so naming one that contains `binDir` disables execution just the same.

The config is read from your home directory and never from the project, because the model
can write in the project — a project-local policy file would be a policy the model edits.
For the same reason the config file itself and `binDir` are never writable, whatever the
write roots say: those two are how the policy gets rewritten rather than worked within.
The capture directory is on that list too — its contents are how one command's output
reaches the next, so a session that could rewrite one could launder a result past you.

tin's own source is not on that list, and does not need to be. The write roots already
answer the question: work anywhere else and this repository is not a root, so it is safe
by not being one; work inside it and editing it is the whole reason you are there.

## What the child process gets

`tin_run` builds the environment from scratch instead of inheriting yours:

- `PATH` is `~/tinbin` and nothing else, so a command that shells out internally also finds
  only allowed commands.
- `TERM=dumb`, and only the variables in `passEnv` are carried over. API keys, tokens,
  `SSH_AUTH_SOCK` and the rest of your environment are not passed to whatever runs. On
  Windows the default list also carries `SystemRoot`, `windir`, `SystemDrive`, `ComSpec`,
  `PATHEXT`, `USERPROFILE`, `USERNAME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`,
  `NUMBER_OF_PROCESSORS` and `PROCESSOR_ARCHITECTURE`, without which most programs there
  fail in ways that are hard to read. Setting `passEnv` yourself replaces the whole list,
  Windows names included.
- stdin is closed, so nothing sits waiting for input. Nothing is piped in either: a
  command that only reads stdin has no way to be fed, and the way output travels between
  commands is [capture](#capturing-output) and a path.
- The command runs in a session of its own, and is killed as a process group on timeout or
  when you press Esc — killing just the child would leave its children running and holding
  the pipes. The session also means no controlling terminal, so an allowed command cannot
  open `/dev/tty` to reach the terminal you are sitting at. Windows has neither, so the
  tree is killed with `taskkill /T` there instead.

Output is capped by bytes and lines, and the model is told when it was truncated. A run
that asked to [capture](#capturing-output) writes its stdout to a file as well, and gets
back the path and the first lines rather than the whole thing; that file is bounded only
by `exec.maxCaptureBytes`.

## What tin is not

tin is a policy layer inside the pi process. It is not an OS sandbox, and pi's own
[security notes](https://pi.dev) are clear that pi does not have one. Specifically:

- **The commands you allow are trusted completely.** Once `git` runs, it runs as you, with
  your files. tin decides *what* may start, not what it does afterwards.
- **Reads are unrestricted by design.** A model that can read `~/.ssh` and then run an
  allowed command that talks to the network can move data out. If that matters for your
  threat model, do not link a network tool.
- **It does not contain other extensions.** Anything else you load runs with full
  permissions and could remove tin's handlers.
- **`!` commands are yours.** Shell commands you type yourself are not gated — you are not
  the thing being sandboxed.
- **There is a theoretical write race.** The path is canonicalized and checked, then pi's
  tool performs the write. Swapping a symlink in between would need the ability to create
  symlinks, which needs an allowed command that can.
- **`tinjs` rests on the engine being sound.** It has no function that writes, so there is
  no policy to get wrong — but it is an interpreter running attacker-chosen source, and a
  memory-safety bug in quickjs would be a way out that no amount of curation upstream of it
  would catch. That is a much higher bar than a forgotten `os.execute`, which is why the
  batteries are the engine's rather than something linked in beside it, but it is not zero.

For genuinely untrusted work, run the whole thing in a container or VM. tin is for the much
more common case: a local model, your own machine, and a strong preference that it not touch
anything outside the directory you pointed it at.

## Development

```sh
npm install
npm test          # policy, path containment, and real subprocess behavior
npm run typecheck # against pi's published types
```

tinjs is a separate C project with no dependencies of its own; it builds and tests on
its own terms, described in [`tinjs/README.md`](tinjs/README.md#building).

The interesting logic is deliberately free of pi imports so it can be tested directly:
`src/paths.ts` (canonicalization and containment), `src/policy.ts` (the gate),
`src/config.ts` (policy resolution), `src/run.ts` (allowlist and execution).
`src/index.ts` is only the wiring, and `bin/tin` is a standalone launcher that knows
nothing about tin beyond the name of one environment variable.
