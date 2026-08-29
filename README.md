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

## Install

tin belongs to you, not to a project, so install it globally:

```sh
git clone <this repo> ~/work/tin
ln -s ~/work/tin/src ~/.pi/agent/extensions/tin
```

That makes it a global extension, active in every pi session and reloadable with `/reload`.
To try it on one session first:

```sh
pi -e ~/work/tin/src/index.ts
```

## Allowing commands

Create the directory and link in exactly what you are willing to let the model run:

```sh
mkdir -p ~/tinbin
ln -s "$(command -v rg)"  ~/tinbin/rg
ln -s "$(command -v git)" ~/tinbin/git
ln -s "$(command -v jq)"  ~/tinbin/jq
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
arbitrary programs through `-exec`. `git` can run hooks and pagers. Prefer narrow tools, or
write a small wrapper script in `~/tinbin` that pins the subcommands you actually want —
[`wrappers/`](wrappers) has a read-only `git` you can link instead of the real one.

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
ln -s ~/work/tin/wrappers/git ~/tinbin/git
```

They are POSIX shell scripts with no dependencies beyond the tool they wrap, written to
the rules above: because `PATH` is the allowlist directory, each calls the real binary by
absolute path, chosen from a short list of the usual locations at the top of the script.
Edit that list if yours lives somewhere else. Read the one you link before you link it —
you are the one who ends up trusting it.

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

The config is read from your home directory and never from the project, because the model
can write in the project — a project-local policy file would be a policy the model edits.
For the same reason, tin's own source directory, its config file, and `binDir` are never
writable, whatever the write roots say.

## What the child process gets

`tin_run` builds the environment from scratch instead of inheriting yours:

- `PATH` is `~/tinbin` and nothing else, so a command that shells out internally also finds
  only allowed commands.
- `TERM=dumb`, and only the variables in `passEnv` are carried over. API keys, tokens,
  `SSH_AUTH_SOCK` and the rest of your environment are not passed to whatever runs.
- stdin is closed, so nothing sits waiting for input.
- The command runs in its own process group and is killed as a group on timeout or when you
  press Esc — killing just the child would leave its children running and holding the pipes.

Output is capped by bytes and lines, and the model is told when it was truncated.

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

For genuinely untrusted work, run the whole thing in a container or VM. tin is for the much
more common case: a local model, your own machine, and a strong preference that it not touch
anything outside the directory you pointed it at.

## Development

```sh
npm install
npm test          # policy, path containment, and real subprocess behavior
npm run typecheck # against pi's published types
```

The interesting logic is deliberately free of pi imports so it can be tested directly:
`src/paths.ts` (canonicalization and containment), `src/policy.ts` (the gate),
`src/config.ts` (policy resolution), `src/run.ts` (allowlist and execution).
`src/index.ts` is only the wiring.
