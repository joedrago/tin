#!/usr/bin/env node
//
// tin wrapper: ripgrep with its two ways out closed.
//
// This is the same policy as `wrappers/rg`, written for Node so that it can run on
// Windows, where there is no shebang line and no POSIX shell to host the sh version.
// Link it into your allowlist directory instead of rg itself:
//
//     mklink %USERPROFILE%\tinbin\rg.mjs C:\work\tin\wrappers\rg.mjs      (Windows)
//     ln -s ~/work/tin/wrappers/rg.mjs ~/tinbin/rg.mjs                    (elsewhere)
//
// The model calls it by the name in the directory, so `rg.mjs`. tin starts a .mjs
// entry on Windows with the node it is itself running on; everywhere else the shebang
// and the executable bit do it.
//
// Do not also link the real rg binary, or the sh wrapper alongside this one — either
// is only worth something if it is the only rg the model can reach.
//
// rg looks like a pure reader and very nearly is: it has no flag that writes a file,
// and everything it produces goes to stdout. What it does have is two flags that hand
// it a program to run, and those are the whole reason this file exists:
//
//   --pre COMMAND          runs COMMAND on every file before searching it
//   --pre-glob GLOB        chooses which files --pre applies to
//   --hostname-bin COMMAND runs COMMAND to find the hostname, for hyperlinks
//
// A third route is not a flag at all: rg reads a config file named by
// RIPGREP_CONFIG_PATH and takes flags — including --pre — out of it. tin builds its
// children an environment from scratch and does not carry that variable over, so it is
// already closed, but relying on that would make this wrapper correct only by something
// another file does. --no-config is passed on every call instead.
//
// -z/--search-zip is left alone deliberately. It runs a decompressor, but only one it
// can find on PATH, and PATH inside tin is the allowlist directory — so it can reach a
// decompressor exactly when you have allowlisted one, which is your decision to have
// already made.
//
// Keep this and `wrappers/rg` in step. They are one policy in two languages, and a rule
// added to one of them is missing from the other until it is added there too.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NAME = "rg (tin wrapper)";

export class Refused extends Error {}

function refuse(message) {
	throw new Refused(message);
}

// --- the real rg ----------------------------------------------------------------
//
// PATH inside tin is the allowlist directory and nothing else, so "rg" here would find
// this script again. The real binary has to be named outright.

function rgCandidates(env) {
	if (process.platform === "win32") {
		return [
			env.TIN_RG,
			env.ProgramW6432 && `${env.ProgramW6432}\\ripgrep\\rg.exe`,
			env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs\\ripgrep\\rg.exe`,
			"C:\\ProgramData\\chocolatey\\bin\\rg.exe",
		];
	}
	return [env.TIN_RG, "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg", "/bin/rg", "/snap/bin/rg"];
}

export function findRg(env = process.env) {
	const found = rgCandidates(env).find((candidate) => candidate && existsSync(candidate));
	if (!found) {
		refuse("no rg binary found. Set TIN_RG, or edit the candidate list in this script.");
	}
	return found;
}

// --- policy ---------------------------------------------------------------------

// Long options that hand rg a program to run. "pre" covers --pre-glob as well, since
// the check below matches on prefixes.
const DANGEROUS_LONG = ["pre", "hostname-bin"];

// Compared in both directions, the way the git wrapper does it. Today's rg parses long
// flags exactly and rejects an abbreviation outright, so only the first direction can
// fire — the second is there so that a parser that starts accepting prefixes does not
// quietly open --pre back up.
function checkLong(name) {
	for (const bad of DANGEROUS_LONG) {
		if (name.startsWith(bad)) {
			refuse(
				`--${name} is not allowed: --pre and --hostname-bin hand rg a program of its own to run, and --pre-glob is part of the first one. Running a program is what the allowlist exists to decide.`,
			);
		}
		if (bad.startsWith(name)) {
			refuse(`--${name} may expand to --${bad}, which hands rg a program of its own to run.`);
		}
	}
}

/** Throws Refused if the arguments contain a way out; returns them unchanged if not. */
export function rgPolicy(argv) {
	let afterDdash = false;
	for (const arg of argv) {
		// Everything after -- is a pattern or a path, never a flag, so it is not
		// examined. Before that, an argument that merely looks like one of these is
		// refused rather than reasoned about: if it is really a pattern, put it after --.
		if (afterDdash) continue;
		if (arg === "--") {
			afterDdash = true;
			continue;
		}
		if (arg.startsWith("--")) checkLong(arg.slice(2).split("=")[0]);
	}
	return argv;
}

/** The config file is the other place --pre can come from. */
export function childEnv(env = process.env) {
	const copy = { ...env };
	delete copy.RIPGREP_CONFIG_PATH;
	return copy;
}

export function main(argv) {
	let allowed;
	let rg;
	try {
		allowed = rgPolicy(argv);
		rg = findRg();
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		process.stderr.write(`${NAME}: ${error.message}\n`);
		return 1;
	}

	const result = spawnSync(rg, ["--no-config", ...allowed], {
		stdio: "inherit",
		env: childEnv(),
		shell: false,
		windowsHide: true,
	});
	if (result.error) {
		process.stderr.write(`${NAME}: could not run ${rg}: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

// Run only when started as a program. Importing this file — the tests do — must not
// launch rg. argv[1] is the allowlist entry tin spawned, which is a link to this file,
// so it is resolved before the comparison; import.meta.url already is.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	process.exitCode = main(process.argv.slice(2));
}
