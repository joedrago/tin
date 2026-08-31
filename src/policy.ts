import path from "node:path";
import type { TinPolicy } from "./config.ts";
import { canonicalize, isInside, segmentsWithin } from "./paths.ts";

/** Tools that only observe the filesystem. Unrestricted: it is all local anyway. */
export const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
/** Tools that mutate files. Allowed only inside a write root. */
export const WRITE_TOOLS = new Set(["write", "edit"]);
/** Arbitrary shells. Always denied — tin_run is the only way to run anything. */
export const SHELL_TOOLS = new Set(["bash", "powershell"]);

export const TIN_RUN = "tin_run";

/** The complete set tin exposes to the model, in the order it reads best. */
export function allowedToolNames(policy: TinPolicy): string[] {
	return [...READ_TOOLS, ...WRITE_TOOLS, TIN_RUN, ...policy.allowTools];
}

export type Decision = { allow: true } | { allow: false; reason: string };

const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

function formatRoots(roots: string[]): string {
	return roots.length > 0 ? roots.join(", ") : "(none)";
}

/**
 * Decide whether a path may be written to.
 *
 * `target` is canonicalized first, so symlinks and `..` are already resolved by the
 * time containment is checked.
 */
export function checkWritePath(input: string, policy: TinPolicy, cwd: string): Decision {
	if (typeof input !== "string" || input.trim() === "") {
		return deny("tin: no path given");
	}
	const target = canonicalize(input, cwd);

	for (const denied of policy.denyPaths) {
		if (isInside(denied, target)) {
			return deny(`tin: ${target} is part of tin's own configuration and is never writable`);
		}
	}

	const root = policy.writeRoots.find((candidate) => isInside(candidate, target));
	if (!root) {
		return deny(
			`tin: writing to ${target} is denied — it is outside the writable roots (${formatRoots(policy.writeRoots)}). ` +
				`Note that symlinks are resolved first, so the real destination is what counts.`,
		);
	}

	const segments = segmentsWithin(root, target) ?? [];
	const blocked = segments.find((segment) => policy.denySegments.includes(segment));
	if (blocked) {
		return deny(
			`tin: writing to ${target} is denied — paths containing "${blocked}" are protected inside ${root}`,
		);
	}

	return allow;
}

/**
 * The gate itself. Anything not explicitly recognized is denied, so a tool added by
 * a future pi version or another extension is unavailable until tin is told about it.
 */
export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
	policy: TinPolicy,
	cwd: string,
): Decision {
	if (policy.allowTools.includes(toolName)) return allow;

	if (READ_TOOLS.has(toolName)) return allow;

	if (SHELL_TOOLS.has(toolName)) {
		return deny(
			`tin: the ${toolName} tool is disabled. Use tin_run to execute one of the allowed commands ` +
				`(it takes a command name and an argument array, and runs without a shell).`,
		);
	}

	if (WRITE_TOOLS.has(toolName)) {
		return checkWritePath(typeof input.path === "string" ? input.path : "", policy, cwd);
	}

	if (toolName === TIN_RUN) return allow; // tin_run validates its own arguments.

	return deny(
		`tin: the ${toolName} tool is not part of tin's allowed set. ` +
			`Allowed: ${allowedToolNames(policy).join(", ")}.`,
	);
}

/** The allowlist entry that is tinjs. Windows needs the extension to be runnable. */
const TINJS_ENTRY = /^tinjs(\.exe)?$/i;

/**
 * What to tell the model about tinjs, when the user has linked it.
 *
 * These lines cost tokens in every session that has it, and they earn them back
 * on the first use: a model that does not know tinjs is there reaches for bash
 * and finds it gone, and a model that knows only its name reaches for
 * require("fs") and spends a turn learning it is not that kind of interpreter.
 * So the blurb states both halves — everything needed to write a working script
 * on the first attempt, and everything that is pointless to attempt at all.
 */
export function describeTinjs(commands: string[]): string[] {
	const name = commands.find((command) => TINJS_ENTRY.test(command));
	if (!name) return [];
	return [
		`- \`${name}\` is a JavaScript interpreter, for the throwaway scripts that would otherwise want a shell: parsing, reshaping, aggregating and summarising data you have read. Call it as \`tin_run { command: "${name}", args: ["-e", "<code>"] }\`, or \`args: ["script.js", ...]\` for anything longer than a line or two.`,
		`  - Standard JavaScript is all present — RegExp (named groups, lookbehind, unicode), JSON, Map, Set, typed arrays, Date, Math, BigInt, classes, generators, async/await.`,
		`  - Added to it: \`read(path)\` and \`readBytes(path)\` for any path on this machine, \`lines(path)\`, \`print(...)\`, \`console.log/error\`, \`inspect(value)\`, \`args\` for the arguments after the script, and \`exit(code)\`.`,
		`  - \`lines(path)\` walks a file one line at a time — \`for (const line of lines(f))\` — holding only one line, so it reads a log of any size where \`read\` would run out of memory. Use it for anything large, including a file written by tin_run's \`capture\`.`,
		`  - It cannot write a file, reach the network, run a program, read the environment, import a module or sleep — there is no API for any of it, so do not look for one. stdout is the only way a result comes back: print it, and use the write tool if it has to land on disk.`,
	];
}

/** One-line summary of the policy, for the status line and /tin. */
export function describePolicy(policy: TinPolicy): string {
	const roots = policy.writeRoots.map((root) => path.basename(root)).join(", ") || "none";
	return `tin: write ${roots} · exec ${policy.execEnabled ? policy.binDir : "off"}`;
}

/**
 * The write roots as a session-start banner, marking the ones granted for this
 * session alone. Write roots are the whole of what tin is protecting, so they are
 * worth stating outright at the top of a session rather than leaving in the status
 * line: an extra root is a thing you asked for once and then have to remember.
 */
export function describeWriteRoots(policy: TinPolicy): string {
	if (policy.writeRoots.length === 0) {
		return "tin: nothing is writable in this session";
	}
	const lines = policy.writeRoots.map((root) =>
		policy.extraWriteRoots.includes(root) ? `  ${root}  (this session only)` : `  ${root}`,
	);
	return [`tin: writable ${lines.length === 1 ? "directory" : "directories"}`, ...lines].join("\n");
}
