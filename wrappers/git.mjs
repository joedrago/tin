#!/usr/bin/env node
//
// tin wrapper: read-only git.
//
// This is the same policy as `wrappers/git`, written for Node so that it can run on
// Windows, where there is no shebang line and no POSIX shell to host the sh version.
// Link it into your allowlist directory instead of git itself:
//
//     mklink %USERPROFILE%\tinbin\git.mjs C:\work\tin\wrappers\git.mjs      (Windows)
//     ln -s ~/work/tin/wrappers/git.mjs ~/tinbin/git.mjs                    (elsewhere)
//
// The model calls it by the name in the directory, so `git.mjs`. tin starts a .mjs
// entry on Windows with the node it is itself running on; everywhere else the shebang
// and the executable bit do it.
//
// Do not also link the real git binary, or the sh wrapper alongside this one — either
// is only worth something if it is the only git the model can reach.
//
// What gets through: an allowlist of subcommands that inspect a repository and never
// change one. Everything that writes objects, refs, the index, the working tree, the
// config, or the network is rejected, as is every option that can be talked into
// running another program.
//
// What this does not do: it does not contain git once git is running. The named config
// hooks are turned off below, but a diff driver you have defined yourself — a textconv
// or a clean filter in your own gitconfig — is still selected by a .gitattributes file,
// and .gitattributes is inside the workspace where the model may write. If you have
// such a driver configured, that program is reachable. The config itself is not: tin
// keeps the model out of .git and out of your home.
//
// Keep this and `wrappers/git` in step. They are one policy in two languages, and a
// rule added to one of them is missing from the other until it is added there too.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "git (tin read-only wrapper)";

export class Refused extends Error {}

function refuse(message) {
	throw new Refused(message);
}

// --- the real git ---------------------------------------------------------------
//
// PATH inside tin is the allowlist directory and nothing else, so "git" here would
// find this script again. The real binary has to be named outright.

function gitCandidates(env) {
	if (process.platform === "win32") {
		return [
			env.TIN_GIT,
			"C:\\Program Files\\Git\\cmd\\git.exe",
			"C:\\Program Files (x86)\\Git\\cmd\\git.exe",
			env.ProgramW6432 && path.join(env.ProgramW6432, "Git", "cmd", "git.exe"),
			env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
		];
	}
	return [env.TIN_GIT, "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"];
}

export function findGit(env = process.env) {
	const found = gitCandidates(env).find((candidate) => candidate && existsSync(candidate));
	if (!found) {
		refuse("no git binary found. Set TIN_GIT, or edit the candidate list in this script.");
	}
	return found;
}

// --- policy ---------------------------------------------------------------------

// Subcommands that only ever read. branch, tag, stash, worktree, reflog and remote
// have a writing mode too and are pinned to their listing mode further down.
const SUBCOMMANDS = new Set(
	`annotate blame branch cat-file check-attr check-ignore cherry count-objects
	 describe diff diff-files diff-index diff-tree for-each-ref grep log ls-files
	 ls-tree merge-base name-rev range-diff reflog remote rev-list rev-parse
	 shortlog show show-branch show-ref stash status tag whatchanged worktree`.split(/\s+/),
);

// Long options that hand git a filename to write or a program to run. Matched against
// abbreviations in both directions, because git expands any unambiguous prefix:
// --open-f=/bin/sh really does reach --open-files-in-pager.
const DANGEROUS_LONG = [
	"output",
	"output-directory",
	"open-files-in-pager",
	"ext-diff",
	"textconv",
	"upload-pack",
	"receive-pack",
	"exec",
	"edit",
	"help",
];

// Options accepted by branch and tag. An exact allowlist, not a denylist, because
// these two are the subcommands where a missed flag deletes something.
const LIST_OPTIONS = new Set(
	`--list --all --remotes --verbose --contains --no-contains --merged --no-merged
	 --points-at --ignore-case --show-current --omit-empty --color --no-color
	 --column --no-column --no-abbrev`.split(/\s+/),
);

// The only ones of those that take a value, so --sort=x is told apart from --sort x.
const LIST_VALUE_OPTIONS = new Set(["--sort", "--format", "--abbrev"]);

// Letters that are listing options of branch and of tag. Anything else in a cluster
// means something destructive rode along inside it.
const LIST_LETTERS = { branch: /[^arviln0-9]/, tag: /[^iln0-9]/ };

function usage(prefix = "") {
	const listed = [...SUBCOMMANDS].map((sub) => `  ${sub}`).join("\n");
	refuse(`${prefix}allowed subcommands are\n${listed}`);
}

/**
 * A long option is rejected if it could expand to a dangerous one, or if it is a
 * dangerous one being abbreviated. "--no-ext-diff" is neither and stays usable.
 */
function checkLong(name) {
	for (const bad of DANGEROUS_LONG) {
		if (name.startsWith(bad)) {
			refuse(`--${name} is not allowed: it can write a file or run a program.`);
		}
		if (bad.startsWith(name)) {
			refuse(`--${name} may expand to --${bad}, which can write a file or run a program.`);
		}
	}
}

/**
 * Short options cluster and they take attached values, so -O can arrive as -vO and as
 * -SxO alike. Rather than look for it, every character after the dash has to be a
 * letter that is safe on its own — which is all of them except o and O — or part of a
 * number (-U3, -M90%). An attached string value has to be split off instead
 * (-S pattern), since there is no telling it apart from a cluster.
 */
function checkShort(arg) {
	const rest = arg.slice(1);
	if (/[oO]/.test(rest)) {
		refuse(
			`${arg} is not allowed: -o writes a file and -O opens a pager, and either can hide ` +
				`inside a bundle. Pass a value as its own argument (-S pattern) if that is what this is.`,
		);
	}
	if (/[^a-np-zA-NP-Z0-9%]/.test(rest)) {
		refuse(
			`${arg} bundles a value into a short option, where another option can hide. ` +
				`Write it as two arguments ("${arg.slice(0, 2)} ${arg.slice(2)}"), or use the long option.`,
		);
	}
}

function checkArgs(args) {
	let afterDdash = false;
	for (const arg of args) {
		if (afterDdash) continue;
		if (arg === "--") {
			afterDdash = true;
		} else if (arg.startsWith("--")) {
			checkLong(arg.slice(2).split("=")[0]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			checkShort(arg);
		}
	}
}

/** branch and tag: an exact allowlist of listing options and nothing else. */
function checkListingOnly(sub, args) {
	const notListing = LIST_LETTERS[sub];
	for (const arg of args) {
		const rejected = `${arg} is not allowed for ${sub}; only listing options are.`;
		if (arg.startsWith("--") && arg.includes("=")) {
			if (!LIST_VALUE_OPTIONS.has(arg.split("=")[0])) refuse(rejected);
		} else if (arg.startsWith("--")) {
			if (!LIST_OPTIONS.has(arg)) refuse(rejected);
		} else if (arg.startsWith("-") && arg.length > 1) {
			// Every letter of a bundle has to be a listing letter of that subcommand,
			// so -d cannot ride along inside -vd while -av and -vv still work.
			if (notListing.test(arg.slice(1))) refuse(rejected);
		}
	}
	checkArgs(args);
}

/**
 * Decide what git may be run with, given everything after the wrapper's own name.
 * Returns the subcommand and arguments to pass on, or throws Refused.
 */
export function gitPolicy(argv) {
	if (argv.length < 1) usage();

	const sub = argv[0];
	let args = argv.slice(1);

	if (sub.startsWith("-")) {
		refuse(
			"top-level git options are not allowed (they can set config, aliases, or the pager). " +
				"Start with a subcommand; use tin_run's cwd to change directory.",
		);
	}
	if (!SUBCOMMANDS.has(sub)) usage(`"${sub}" is not a read-only subcommand.\n`);

	// Subcommands with a writing mode are pinned to their listing mode. git itself then
	// refuses the destructive flags — "git branch --list -d main" is an error, not a
	// deletion — and the allowlist above keeps them from being passed at all.
	switch (sub) {
		case "branch":
		case "tag":
			checkListingOnly(sub, args);
			args = ["--list", ...args];
			break;
		case "stash":
			if (args.length < 1) refuse('only "stash list" and "stash show" are allowed.');
			if (args[0] !== "list" && args[0] !== "show") {
				refuse(
					`only "stash list" and "stash show" are allowed; "stash ${args[0]}" changes ` +
						`the stash or the working tree.`,
				);
			}
			checkArgs(args);
			break;
		case "worktree":
			if (args[0] !== "list") refuse('only "worktree list" is allowed.');
			checkArgs(args);
			break;
		case "reflog":
			// Same trick as --list: pinning "show" turns "reflog delete" into a request
			// to show the reflog of a ref named "delete", which harmlessly fails.
			checkArgs(args);
			if (args[0] !== "show") args = ["show", ...args];
			break;
		case "remote":
			if (args.length > 1 || (args.length === 1 && args[0] !== "-v" && args[0] !== "--verbose")) {
				refuse(
					'only "remote" and "remote -v" are allowed; the other forms write config or ' +
						"contact the network.",
				);
			}
			break;
		default:
			checkArgs(args);
	}

	return [sub, ...args];
}

// --- run it ---------------------------------------------------------------------

// Anything git might read out of the environment and turn into a program. Compared
// case-insensitively because that is how Windows treats environment names, and a
// variable that arrived as "Git_Dir" is the same variable there.
const STRIPPED_ENV = new Set(
	`GIT_EXTERNAL_DIFF GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_PARAMETERS
	 GIT_CONFIG_COUNT GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
	 GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_EDITOR GIT_SEQUENCE_EDITOR GIT_SSH
	 GIT_SSH_COMMAND GIT_PROXY_COMMAND GIT_ASKPASS GIT_ATTR_SOURCE`
		.split(/\s+/)
		.map((name) => name.toLowerCase()),
);

export function childEnv(parent = process.env) {
	const env = {};
	for (const [key, value] of Object.entries(parent)) {
		if (!STRIPPED_ENV.has(key.toLowerCase())) env[key] = value;
	}
	return {
		...env,
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

// The -c settings neutralize the config hooks that turn a read into an exec, in case
// the repository (or your own gitconfig) sets one. --no-optional-locks keeps a plain
// "status" from refreshing the on-disk index, so the read stays a read.
//
// "false" is the POSIX command that does nothing and fails. On Windows there is no
// such program, so the setting fails to launch anything instead of launching something
// that does nothing — which is the same outcome by a different route.
export function hardeningFlags() {
	const nowhere = process.platform === "win32" ? "NUL" : "/dev/null";
	return [
		"-c",
		"core.pager=cat",
		"-c",
		"core.editor=false",
		"-c",
		"sequence.editor=false",
		"-c",
		`core.hooksPath=${nowhere}`,
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.sshCommand=false",
		"-c",
		"diff.external=",
		"-c",
		"gpg.program=false",
		"-c",
		"credential.helper=",
		"-c",
		"protocol.ext.allow=never",
		"-c",
		"uploadpack.packObjectsHook=",
		"--no-pager",
		"--no-optional-locks",
	];
}

function main(argv) {
	let allowed;
	let git;
	try {
		allowed = gitPolicy(argv);
		git = findGit();
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		process.stderr.write(`${NAME}: ${error.message}\n`);
		return 1;
	}

	const result = spawnSync(git, [...hardeningFlags(), ...allowed], {
		stdio: "inherit",
		env: childEnv(),
		shell: false,
		windowsHide: true,
	});
	if (result.error) {
		process.stderr.write(`${NAME}: could not run ${git}: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

// Run only when started as a program. Importing this file — the tests do — must not
// launch git. argv[1] is the allowlist entry tin spawned, which is a link to this
// file, so it is resolved before the comparison; import.meta.url already is.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	process.exitCode = main(process.argv.slice(2));
}
