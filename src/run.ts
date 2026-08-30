import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import type { TinPolicy } from "./config.ts";
import { canonicalize, isInside } from "./paths.ts";

/** Command names must be a bare filename in binDir — no paths, no traversal. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Whether a resolved target counts as runnable.
 *
 * Windows has no executable bit: Node derives st_mode from the read-only
 * attribute, so every file there reads as mode 0o666 or 0o444 and the 0o111 test
 * rejects everything. On Windows, having been linked into binDir at all is the
 * allowlist decision; everywhere else the bit still has to be set.
 */
function isRunnable(stats: Stats): boolean {
	return process.platform === "win32" || (stats.mode & 0o111) !== 0;
}

export interface ResolvedCommand {
	name: string;
	/** The entry in binDir, which is what we execute. */
	link: string;
	/** What it actually points at, after following symlinks. */
	target: string;
}

export class TinDenied extends Error {}

/**
 * Resolve a command name against the allowlist directory.
 *
 * The entry may be a symlink (the intended use) or a real script. What matters is
 * that it sits directly in binDir, which lives outside every writable root.
 */
export function resolveCommand(name: string, policy: TinPolicy): ResolvedCommand {
	if (!policy.execEnabled) {
		throw new TinDenied(
			`tin: command execution is disabled (${policy.binDir} is missing or writable). Nothing can be run.`,
		);
	}
	if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
		throw new TinDenied(
			`tin: "${name}" is not a valid command name. Give a bare name that is linked in ${policy.binDir}, not a path.`,
		);
	}

	const link = path.join(policy.binDir, name);
	try {
		lstatSync(link);
	} catch {
		throw new TinDenied(
			`tin: "${name}" is not an allowed command. Allowed: ${listCommands(policy).join(", ") || "(none)"}.`,
		);
	}

	let target: string;
	try {
		target = realpathSync(link);
	} catch {
		throw new TinDenied(`tin: "${name}" is a broken link in ${policy.binDir}.`);
	}

	const stats = statSync(target);
	if (!stats.isFile()) {
		throw new TinDenied(`tin: "${name}" does not resolve to a file.`);
	}
	if (!isRunnable(stats)) {
		throw new TinDenied(`tin: "${name}" resolves to ${target}, which is not executable.`);
	}

	return { name, link, target };
}

/** Names currently linked in binDir, sorted. Broken and non-runnable entries are skipped. */
export function listCommands(policy: TinPolicy): string[] {
	if (!policy.execEnabled) return [];
	let entries: string[];
	try {
		entries = readdirSync(policy.binDir);
	} catch {
		return [];
	}
	const usable: string[] = [];
	for (const entry of entries) {
		if (!COMMAND_NAME.test(entry)) continue;
		try {
			const stats = statSync(path.join(policy.binDir, entry));
			if (stats.isFile() && isRunnable(stats)) usable.push(entry);
		} catch {
			// Broken link or unreadable target; not offered.
		}
	}
	return usable.sort();
}

/**
 * Build the child environment from scratch.
 *
 * Only the listed variables are carried over, so API keys, tokens, and agent
 * variables in pi's environment are not handed to whatever gets run. PATH is the
 * allowlist directory itself, so a command that shells out finds only allowed
 * commands too.
 */
export function buildChildEnv(
	policy: TinPolicy,
	parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = { PATH: policy.binDir, TERM: "dumb" };
	for (const key of policy.exec.passEnv) {
		const value = parent[key];
		if (typeof value === "string") env[key] = value;
	}
	return { ...env, ...policy.exec.env };
}

/** Resolve the requested working directory, which must stay inside a write root. */
export function resolveWorkingDirectory(
	requested: string | undefined,
	policy: TinPolicy,
	cwd: string,
): string {
	if (requested === undefined || requested === "") return cwd;
	const resolved = canonicalize(requested, cwd);
	if (!policy.writeRoots.some((root) => isInside(root, resolved))) {
		throw new TinDenied(
			`tin: cwd ${resolved} is outside the writable roots (${policy.writeRoots.join(", ") || "none"}).`,
		);
	}
	return resolved;
}

export interface ExecOutcome {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
}

interface Capture {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
}

function capture(): Capture {
	return { chunks: [], bytes: 0, truncated: false };
}

function append(sink: Capture, chunk: Buffer, limit: number): void {
	if (sink.bytes >= limit) {
		sink.truncated = true;
		return;
	}
	const room = limit - sink.bytes;
	if (chunk.length > room) {
		sink.chunks.push(chunk.subarray(0, room));
		sink.bytes = limit;
		sink.truncated = true;
		return;
	}
	sink.chunks.push(chunk);
	sink.bytes += chunk.length;
}

function finish(sink: Capture, maxLines: number): { text: string; truncated: boolean } {
	let text = Buffer.concat(sink.chunks).toString("utf8");
	let truncated = sink.truncated;
	const lines = text.split("\n");
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	return { text, truncated };
}

const KILL_GRACE_MS = 2_000;

// How long to wait for the output pipes once the child itself has exited. Anything
// that got out of the kill — a grandchild that called setsid, or on Windows one that
// outlived taskkill — holds the write ends open, and "close" never fires. Past this
// we drop the pipes and report what was captured.
const PIPE_GRACE_MS = 1_000;

/**
 * Kill a whole process tree on Windows, where a signal only ever reaches one process.
 * taskkill /T walks the children itself. /F is all it offers, which is also all
 * child.kill() would do there.
 */
function killTreeWindows(child: ChildProcess): void {
	const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const args = ["/pid", String(child.pid), "/T", "/F"];
	try {
		const killer = spawn(path.join(system32, "taskkill.exe"), args, {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => child.kill());
	} catch {
		// taskkill is missing or unspawnable; the single process is all we can reach.
		child.kill();
	}
}

/** Windows script types that are not images and so cannot be started on their own. */
const WINDOWS_BATCH = /\.(?:bat|cmd)$/i;
const WINDOWS_NODE_SCRIPT = /\.(?:mjs|cjs|js)$/i;

function comSpec(): string {
	return (
		process.env.ComSpec ??
		path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
	);
}

/**
 * Quote one value so it survives cmd.exe and reaches the program unchanged.
 *
 * Two different parsers see it. The C runtime of whatever finally starts splits on
 * unquoted whitespace and reads \" as a literal quote, so the value is wrapped in
 * quotes with its own quotes escaped and the backslashes in front of them doubled.
 * Before that, cmd scans the line for its own metacharacters — which it acts on even
 * inside quotes, because /c takes the tail verbatim rather than as a quoted string —
 * and a caret in front of each one turns it back into a character.
 *
 * %NAME% is covered by the same carets, but for a different reason: there is no
 * escape for a percent on a command line, and the caret is not one. It survives
 * because cmd looks for the %NAME% shape before it removes carets, and ^%NAME^% is
 * not that shape — so the expansion never happens and the carets come off after.
 *
 * `passes` is how many cmd parses the value goes through, each of which eats one
 * layer of carets: one for the command line itself, and a second for a batch file,
 * whose %* is substituted into a line that is then parsed again.
 */
export function quoteForCmd(value: string, passes: number): string {
	let quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	for (let pass = 0; pass < passes; pass++) {
		quoted = quoted.replace(/[()%!^"<>&|]/g, "^$&");
	}
	return quoted;
}

export interface Launch {
	file: string;
	args: string[];
	verbatim: boolean;
}

/**
 * Work out what to actually hand to CreateProcess.
 *
 * Everywhere but Windows, and for a real executable on Windows, that is the allowlist
 * entry itself. A .bat or .cmd is not an image: Windows cannot start one, and since
 * Node 18.20 (CVE-2024-27980) spawning one without a shell does not quietly fall back
 * to cmd either — it fails with EINVAL. So cmd is invoked explicitly, with the whole
 * command line built here and windowsVerbatimArguments set, because Node's own
 * quoting is written for the C runtime and would leave cmd's metacharacters live.
 *
 * This is still not a shell for the model: it is one fixed `cmd /d /s /c` around one
 * resolved allowlist entry, with every argument escaped to arrive as a literal.
 */
export function buildLaunch(command: ResolvedCommand, args: string[]): Launch {
	if (process.platform !== "win32") return { file: command.link, args, verbatim: false };

	// A Node script is the other thing Windows cannot start, and for the same reason:
	// there is no shebang line, so the extension is all there is to go on. It is worth
	// handling because a wrapper with a policy in it wants a real language, and one
	// written for node needs nothing found or installed — pi is already running on it,
	// so process.execPath is the interpreter, known exactly rather than searched for.
	// Arguments go straight into argv with no shell and no cmd in the way. Node reads
	// none of its own options from this list either: everything after the script path
	// is the script's. NODE_OPTIONS would still be read, but tin builds the child
	// environment itself and does not carry it over.
	if (WINDOWS_NODE_SCRIPT.test(command.link)) {
		return { file: process.execPath, args: [command.link, ...args], verbatim: false };
	}

	if (WINDOWS_BATCH.test(command.link)) {
		// The batch file's own path is parsed once; its arguments are parsed again on
		// the line %* expands into.
		const line = [quoteForCmd(command.link, 1), ...args.map((arg) => quoteForCmd(arg, 2))].join(
			" ",
		);
		// /d skips AutoRun commands out of the registry, which would otherwise run first.
		// /s makes cmd strip exactly the outer quotes and take the rest as written.
		return { file: comSpec(), args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
	}

	return { file: command.link, args, verbatim: false };
}

/**
 * Run an allowed command with an argument array. No shell is involved, so the
 * arguments reach the process verbatim: no globbing, no expansion, no redirection,
 * no command substitution. stdin is closed so nothing can wait for input.
 *
 * On POSIX the child gets a session of its own, which is doing two jobs. It gives us a
 * process group to kill: killing only the child leaves its own children running, and
 * they hold the output pipes open, so a timeout would not actually end the call. It
 * also drops the controlling terminal, so an allowed command cannot open /dev/tty to
 * reach the terminal pi is running in, or push keystrokes into the shell that started
 * it.
 *
 * Windows has neither. Detaching there buys nothing — process.kill(-pid) is not a group
 * kill on Windows, it is a pid that cannot exist — and costs the console some commands
 * expect, plus an orphan that outlives pi. The tree is killed with taskkill instead.
 */
export function execCommand(
	command: ResolvedCommand,
	args: string[],
	options: { cwd: string; env: Record<string, string>; policy: TinPolicy; signal?: AbortSignal },
	onData?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<ExecOutcome> {
	const { exec } = options.policy;
	const startedAt = Date.now();

	const launch = buildLaunch(command, args);

	return new Promise<ExecOutcome>((resolve, reject) => {
		const child = spawn(launch.file, launch.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
			windowsHide: true,
			windowsVerbatimArguments: launch.verbatim,
		});

		const out = capture();
		const err = capture();
		let timedOut = false;
		let settled = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		const timers: NodeJS.Timeout[] = [];

		const killGroup = (signal: NodeJS.Signals) => {
			if (settled || child.pid === undefined) return;
			if (process.platform === "win32") {
				killTreeWindows(child);
				return;
			}
			try {
				process.kill(-child.pid, signal);
			} catch {
				// The group is already gone, or we raced its exit.
				child.kill(signal);
			}
		};

		const stop = (reason: "timeout" | "abort") => {
			if (reason === "timeout") timedOut = true;
			killGroup("SIGTERM");
			// Nothing to escalate to on Windows: the first kill is already a forced one.
			if (process.platform !== "win32") {
				timers.push(setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref());
			}
		};

		const onAbort = () => stop("abort");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = () => {
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		timers.push(setTimeout(() => stop("timeout"), exec.timeoutMs).unref());
		if (options.signal?.aborted) stop("abort");

		child.stdout.on("data", (chunk: Buffer) => {
			append(out, chunk, exec.maxOutputBytes);
			onData?.("stdout", chunk.toString("utf8"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			append(err, chunk, exec.maxOutputBytes);
			onData?.("stderr", chunk.toString("utf8"));
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		const settle = () => {
			if (settled) return;
			cleanup();
			const stdout = finish(out, exec.maxOutputLines);
			const stderr = finish(err, exec.maxOutputLines);
			resolve({
				stdout: stdout.text,
				stderr: stderr.text,
				exitCode,
				signal: exitSignal,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
				durationMs: Date.now() - startedAt,
			});
		};

		child.on("close", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			settle();
		});

		// "close" waits on the pipes as well as the process, so whatever is still holding
		// them keeps this call open long after the command itself is over. Once the child
		// is gone, give the pipes a moment to drain and then stop waiting on them.
		child.on("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			timers.push(
				setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					settle();
				}, PIPE_GRACE_MS).unref(),
			);
		});
	});
}

/** Render an outcome as the text the model sees. */
export function formatOutcome(command: string, args: string[], outcome: ExecOutcome): string {
	const parts: string[] = [];
	const invocation = [command, ...args].join(" ");

	if (outcome.timedOut) {
		parts.push(`${invocation} was killed after ${outcome.durationMs}ms (tin timeout)`);
	} else if (outcome.signal !== null) {
		parts.push(`${invocation} was killed by ${outcome.signal} after ${outcome.durationMs}ms`);
	} else {
		parts.push(`${invocation} exited with code ${outcome.exitCode ?? "unknown"}`);
	}

	if (outcome.stdout.trim() !== "") parts.push(`stdout:\n${outcome.stdout.trimEnd()}`);
	if (outcome.stderr.trim() !== "") parts.push(`stderr:\n${outcome.stderr.trimEnd()}`);
	if (outcome.stdout.trim() === "" && outcome.stderr.trim() === "") parts.push("(no output)");
	if (outcome.truncated) {
		parts.push("[output truncated by tin — re-run with narrower arguments to see the rest]");
	}

	return parts.join("\n\n");
}
