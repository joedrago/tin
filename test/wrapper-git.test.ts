import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error - the wrapper is plain JavaScript, deliberately: it has to stay
// runnable straight out of the allowlist directory, with nothing compiled first.
import { childEnv, gitPolicy, hardeningFlags, Refused } from "../wrappers/git.mjs";

/** The argument list the wrapper would hand to git. */
function allowed(...argv: string[]): string[] {
	return gitPolicy(argv) as string[];
}

function refused(...argv: string[]): string {
	try {
		gitPolicy(argv);
	} catch (error) {
		assert.ok(error instanceof Refused, `expected a refusal, got ${error}`);
		return (error as Error).message;
	}
	return assert.fail(`${argv.join(" ")} was allowed through`);
}

test("read-only subcommands pass through untouched", () => {
	assert.deepEqual(allowed("status", "--short"), ["status", "--short"]);
	assert.deepEqual(allowed("log", "-n", "5", "--pretty=format:%h %s"), [
		"log",
		"-n",
		"5",
		"--pretty=format:%h %s",
	]);
	assert.deepEqual(allowed("diff", "HEAD~1", "--", "src"), ["diff", "HEAD~1", "--", "src"]);
	assert.deepEqual(allowed("show", "abc123"), ["show", "abc123"]);
	assert.deepEqual(allowed("rev-parse", "--show-toplevel"), ["rev-parse", "--show-toplevel"]);
});

test("subcommands that write anything are refused", () => {
	for (const sub of [
		"commit",
		"add",
		"push",
		"pull",
		"fetch",
		"clone",
		"config",
		"checkout",
		"switch",
		"restore",
		"reset",
		"rebase",
		"merge",
		"am",
		"apply",
		"clean",
		"rm",
		"mv",
		"init",
		"gc",
		"filter-branch",
		"submodule",
		"bisect",
		"send-email",
		"daemon",
		"update-ref",
		"symbolic-ref",
		"notes",
		"replace",
		"bundle",
		"archive",
	]) {
		assert.match(refused(sub), /is not a read-only subcommand/, sub);
	}
});

test("top-level options are refused before any subcommand", () => {
	for (const arg of ["-c", "--exec-path=/tmp", "--git-dir=.git", "-C", "--config-env=x", "-P"]) {
		assert.match(refused(arg, "status"), /top-level git options are not allowed/, arg);
	}
});

test("nothing runs with no subcommand at all", () => {
	assert.match(refused(), /allowed subcommands are/);
});

test("options that write a file or run a program are refused, abbreviations included", () => {
	// The full names.
	for (const arg of ["--output=/tmp/x", "--textconv", "--ext-diff", "--upload-pack=sh", "--exec=sh"]) {
		assert.match(refused("log", arg), /write a file or run a program/, arg);
	}
	// Prefixes git would expand to them. --open-f really does reach --open-files-in-pager.
	for (const arg of ["--open-f=/bin/sh", "--out=/tmp/x", "--text", "--upload", "--e", "--h"]) {
		assert.match(refused("log", arg), /write a file or run a program/, arg);
	}
	// And a longer form of one, in case git ever grows the suffix.
	assert.match(refused("log", "--outputs"), /write a file or run a program/);
});

test("--no-ext-diff is not an abbreviation of anything dangerous", () => {
	assert.deepEqual(allowed("diff", "--no-ext-diff"), ["diff", "--no-ext-diff"]);
	assert.deepEqual(allowed("log", "--no-color", "--numstat"), ["log", "--no-color", "--numstat"]);
});

test("-o and -O are refused wherever they hide in a cluster", () => {
	for (const arg of ["-o", "-O", "-vO", "-SxO", "-no", "-w-O"]) {
		assert.match(refused("log", arg), /-o writes a file and -O opens a pager/, arg);
	}
});

test("short options may not carry an attached value", () => {
	for (const arg of ["-Sxy bar", "-S=x", "-U/tmp/x", "-M.5"]) {
		assert.match(refused("log", arg), /bundles a value into a short option/, arg);
	}
	// A value with an o in it trips the -o check first, which is the same order the
	// shell wrapper uses: the cheaper, blunter rule runs before the shape rule.
	assert.match(refused("log", "-Sfoo"), /-o writes a file and -O opens a pager/);
	// Split apart, and the plain letter-and-number forms, are fine.
	assert.deepEqual(allowed("log", "-S", "foo"), ["log", "-S", "foo"]);
	assert.deepEqual(allowed("diff", "-U3", "-M90%"), ["diff", "-U3", "-M90%"]);
});

test("everything after -- is a pathspec, not an option", () => {
	assert.deepEqual(allowed("log", "--", "--output=/tmp/x", "-O"), [
		"log",
		"--",
		"--output=/tmp/x",
		"-O",
	]);
	// But only after it.
	assert.match(refused("log", "--output=/tmp/x", "--"), /write a file or run a program/);
});

test("branch and tag are pinned to listing, and take only listing options", () => {
	assert.deepEqual(allowed("branch"), ["branch", "--list"]);
	assert.deepEqual(allowed("branch", "-av"), ["branch", "--list", "-av"]);
	assert.deepEqual(allowed("branch", "--all", "--sort=-committerdate"), [
		"branch",
		"--list",
		"--all",
		"--sort=-committerdate",
	]);
	assert.deepEqual(allowed("tag", "-l", "v1*"), ["tag", "--list", "-l", "v1*"]);

	for (const args of [
		["branch", "-d", "main"],
		["branch", "-D", "main"],
		["branch", "-m", "old", "new"],
		["branch", "-vd", "main"],
		["branch", "--delete", "main"],
		["branch", "--move", "x"],
		["branch", "--edit-description"],
		["branch", "--set-upstream-to=origin/main"],
		["tag", "-d", "v1"],
		["tag", "-a", "v1"],
		["tag", "-s", "v1"],
		["tag", "-av"],
	]) {
		assert.match(refused(...args), /only listing options are/, args.join(" "));
	}
});

test("branch and tag reject a value option that is not on their list", () => {
	assert.match(refused("branch", "--contains=x"), /only listing options are/);
	assert.deepEqual(allowed("branch", "--format=%(refname)"), [
		"branch",
		"--list",
		"--format=%(refname)",
	]);
});

test("stash, worktree, reflog and remote are pinned to their reading forms", () => {
	assert.deepEqual(allowed("stash", "list"), ["stash", "list"]);
	assert.deepEqual(allowed("stash", "show", "stash@{0}"), ["stash", "show", "stash@{0}"]);
	for (const args of [
		["stash"],
		["stash", "pop"],
		["stash", "drop"],
		["stash", "push"],
		["stash", "clear"],
		["stash", "apply"],
	]) {
		assert.match(refused(...args), /only "stash list" and "stash show" are allowed/, args.join(" "));
	}

	assert.deepEqual(allowed("worktree", "list"), ["worktree", "list"]);
	for (const args of [["worktree"], ["worktree", "add", "x"], ["worktree", "remove", "x"]]) {
		assert.match(refused(...args), /only "worktree list" is allowed/, args.join(" "));
	}

	// reflog is pinned by prepending show, which turns "reflog delete" into a request
	// for the reflog of a ref named "delete".
	assert.deepEqual(allowed("reflog"), ["reflog", "show"]);
	assert.deepEqual(allowed("reflog", "show", "HEAD"), ["reflog", "show", "HEAD"]);
	assert.deepEqual(allowed("reflog", "delete", "HEAD@{0}"), [
		"reflog",
		"show",
		"delete",
		"HEAD@{0}",
	]);

	assert.deepEqual(allowed("remote"), ["remote"]);
	assert.deepEqual(allowed("remote", "-v"), ["remote", "-v"]);
	for (const args of [
		["remote", "add", "x", "url"],
		["remote", "remove", "x"],
		["remote", "set-url", "x", "url"],
		["remote", "update"],
		["remote", "-v", "extra"],
	]) {
		assert.match(refused(...args), /only "remote" and "remote -v" are allowed/, args.join(" "));
	}
});

test("the config hooks that turn a read into an exec are overridden", () => {
	const flags = hardeningFlags() as string[];
	const settings = flags.filter((_, index) => flags[index - 1] === "-c");
	for (const key of [
		"core.pager=cat",
		"core.editor=false",
		"sequence.editor=false",
		"core.fsmonitor=false",
		"core.sshCommand=false",
		"diff.external=",
		"gpg.program=false",
		"credential.helper=",
		"protocol.ext.allow=never",
		"uploadpack.packObjectsHook=",
	]) {
		assert.ok(settings.includes(key), `missing -c ${key}`);
	}
	assert.ok(settings.some((setting) => setting.startsWith("core.hooksPath=")));
	assert.ok(flags.includes("--no-pager"));
	assert.ok(flags.includes("--no-optional-locks"));
});

test("the environment git runs in carries nothing it can turn into a program", () => {
	const env = childEnv({
		PATH: "/tin",
		GIT_EXTERNAL_DIFF: "sh",
		GIT_SSH_COMMAND: "sh",
		GIT_CONFIG_GLOBAL: "/tmp/evil",
		GIT_DIR: "/tmp/elsewhere",
		GIT_ASKPASS: "sh",
		// Windows environment names are case-insensitive, so this is the same variable.
		Git_Editor: "sh",
		HOME: "/home/joe",
	}) as Record<string, string | undefined>;

	for (const key of [
		"GIT_EXTERNAL_DIFF",
		"GIT_SSH_COMMAND",
		"GIT_CONFIG_GLOBAL",
		"GIT_DIR",
		"GIT_ASKPASS",
		"Git_Editor",
	]) {
		assert.equal(env[key], undefined, key);
	}
	assert.equal(env.PATH, "/tin");
	assert.equal(env.HOME, "/home/joe");
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
	assert.equal(env.GIT_PAGER, "cat");
});
