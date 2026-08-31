import { type ChildProcess, spawn } from "node:child_process";
import {
	createWriteStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	type Stats,
	statSync,
	type WriteStream,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
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

export interface CaptureOutcome {
	path: string;
	bytes: number;
	lines: number;
	/** The command outran maxCaptureBytes and the file stops short of its output. */
	truncated: boolean;
}

export interface ExecOutcome {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
	/** Present when the run was asked to capture; absent when it was not. */
	capture?: CaptureOutcome;
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

// How long to wait for a capture file to flush once the command is over. The path
// is handed back as something to read, so it has to be on disk before this call
// resolves; this bounds the wait if the stream never closes.
const CAPTURE_FLUSH_GRACE_MS = 5_000;

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
 * The file a captured run's stdout is written to as it arrives.
 *
 * Capture exists so that a command's output does not have to fit in the
 * conversation to be useful: it goes to disk, and the model is handed the path to
 * give to the next command. So this counts what goes past rather than keeping it,
 * and the only memory involved is the stream's own queue — which is why the child
 * is paused whenever that queue is full. Without that, a fast producer would turn
 * a bounded file into unbounded memory, which is the problem capture was meant to
 * solve.
 *
 * stderr is deliberately not part of this. A capture file is data for another
 * program to read, and a warning interleaved into it corrupts that quietly; the
 * tool result is where stderr belongs, in front of the person and the model.
 */
class CaptureFile {
	bytes = 0;
	lines = 0;
	truncated = false;
	/** The first write error, if the file stopped being writable partway. */
	failure: Error | undefined;

	readonly path: string;

	private readonly limit: number;
	private readonly source: Readable;
	private readonly stream: WriteStream;
	private endedWithNewline = true;
	private closed = false;
	private paused = false;

	constructor(target: string, limit: number, source: Readable) {
		this.path = target;
		this.limit = limit;
		this.source = source;
		this.stream = createWriteStream(target, { mode: 0o600 });
		this.stream.on("error", (error: Error) => {
			this.failure ??= error;
		});
		this.stream.on("close", () => {
			this.closed = true;
		});
	}

	write(chunk: Buffer): void {
		if (this.failure !== undefined) return;
		if (this.bytes >= this.limit) {
			this.truncated = true;
			return;
		}

		let piece = chunk;
		if (this.bytes + chunk.length > this.limit) {
			piece = chunk.subarray(0, this.limit - this.bytes);
			this.truncated = true;
		}
		this.bytes += piece.length;

		// indexOf rather than a walk over the bytes: this runs on every chunk of a
		// file that may be gigabytes, and the line count is only used to describe it.
		for (let at = piece.indexOf(0x0a); at !== -1; at = piece.indexOf(0x0a, at + 1)) this.lines++;
		if (piece.length > 0) this.endedWithNewline = piece[piece.length - 1] === 0x0a;

		if (!this.stream.write(piece)) {
			this.paused = true;
			this.source.pause();
			this.stream.once("drain", () => {
				this.paused = false;
				this.source.resume();
			});
		}
	}

	/** True while there are bytes on their way to disk that have not arrived yet. */
	get inFlight(): boolean {
		return this.paused || this.stream.writableLength > 0;
	}

	/** How much is queued, so a caller can tell moving from wedged. */
	get queued(): number {
		return this.stream.writableLength;
	}

	/** Lines as a person counts them: a last line with no newline is still a line. */
	get lineCount(): number {
		return this.lines + (this.bytes > 0 && !this.endedWithNewline ? 1 : 0);
	}

	/**
	 * Close the file and wait for it to actually be on disk.
	 *
	 * The path is about to be handed to the model as something to read, so
	 * resolving before the stream has flushed would hand back a file that is
	 * quietly short. "close" covers both endings, since autoClose emits it after a
	 * failure as well as after a clean finish.
	 */
	finish(): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.closed) {
				resolve();
				return;
			}
			this.stream.once("close", () => resolve());
			this.stream.end();
			setTimeout(resolve, CAPTURE_FLUSH_GRACE_MS).unref();
		});
	}
}

/**
 * Create the capture directory if this session has not captured yet, and name the
 * file this run will write to.
 *
 * mkdir rather than a recursive create: the parent is the OS temp directory,
 * which is shared, and a plain mkdir fails if anything is already at the name
 * instead of following it somewhere else. 0700 keeps the contents to the user
 * whose output it is.
 *
 * The name carries a sequence number and the command, which are for the person
 * reading `ls` later; the command name has already been through COMMAND_NAME, so
 * it holds no separator and cannot climb out of the directory.
 */
export function nextCapturePath(policy: TinPolicy, command: string): string {
	try {
		mkdirSync(policy.captureDir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new TinDenied(
				`tin: cannot create the capture directory ${policy.captureDir}: ${(error as Error).message}`,
			);
		}
	}
	captureSequence += 1;
	return path.join(policy.captureDir, `${captureSequence}-${command}.out`);
}

/** Start the run numbering over. Called when a session starts, and by tests. */
export function resetCaptureSequence(): void {
	captureSequence = 0;
}

let captureSequence = 0;

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
	options: {
		cwd: string;
		env: Record<string, string>;
		policy: TinPolicy;
		signal?: AbortSignal;
		/** Where to write stdout as it arrives. Absent for an uncaptured run. */
		capturePath?: string;
	},
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
		const file =
			options.capturePath === undefined
				? undefined
				: new CaptureFile(options.capturePath, exec.maxCaptureBytes, child.stdout);
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
			file?.write(chunk);
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

			// A capture file is about to be named to the model as something to read,
			// so the run is not over until the bytes are actually on disk. There is
			// nothing to wait for when the run was not capturing.
			const flushed = file ? file.finish() : Promise.resolve();
			flushed.then(() => {
				if (file?.failure !== undefined) {
					reject(
						new Error(
							`tin: capturing ${command.name} to ${file.path} failed after ${file.bytes} bytes: ${file.failure.message}`,
						),
					);
					return;
				}
				resolve({
					stdout: stdout.text,
					stderr: stderr.text,
					exitCode,
					signal: exitSignal,
					timedOut,
					truncated: stdout.truncated || stderr.truncated,
					durationMs: Date.now() - startedAt,
					capture: file
						? {
								path: file.path,
								bytes: file.bytes,
								lines: file.lineCount,
								truncated: file.truncated,
							}
						: undefined,
				});
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

			// A capture that is still moving bytes onto disk is not what this timer is
			// for — it is here for a grandchild holding the pipes — and cutting the
			// pipes mid-drain would leave a file quietly short of the output it is
			// supposed to be. So it gets another interval for as long as the queue is
			// going down, and the check on the queue standing still is what keeps a
			// wedged device from holding the call open forever.
			let lastQueued = -1;
			const stopWaiting = () => {
				if (file?.inFlight === true && file.queued !== lastQueued) {
					lastQueued = file.queued;
					timers.push(setTimeout(stopWaiting, PIPE_GRACE_MS).unref());
					return;
				}
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle();
			};
			timers.push(setTimeout(stopWaiting, PIPE_GRACE_MS).unref());
		});
	});
}

/** How many lines of a capture file to show, as an idea of what landed in it. */
const CAPTURE_PREVIEW_LINES = 30;

function describeBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Describe a capture file instead of pasting what is in it.
 *
 * The point of capturing is that the output does not have to come back through
 * the conversation, so quoting it here would undo the whole thing. What does come
 * back is the shape of it — where, how big, how many lines — and enough of the
 * top to tell at a glance whether the command produced what was wanted, which is
 * the difference between noticing a mistake now and noticing it two calls later
 * inside something that could not parse it.
 */
function describeCapture(capture: CaptureOutcome, stdout: string): string[] {
	const parts: string[] = [];
	const size = `${describeBytes(capture.bytes)}, ${capture.lines} line${capture.lines === 1 ? "" : "s"}`;
	parts.push(
		capture.truncated
			? `stdout was captured to ${capture.path} (${size}), truncated at tin's capture ceiling — the command produced more than the file holds`
			: `stdout was captured to ${capture.path} (${size})`,
	);

	const lines = stdout.split("\n");
	const shown = lines.slice(0, CAPTURE_PREVIEW_LINES).join("\n").trimEnd();
	if (shown !== "") {
		parts.push(
			lines.length > CAPTURE_PREVIEW_LINES || capture.lines > CAPTURE_PREVIEW_LINES
				? `first ${CAPTURE_PREVIEW_LINES} lines:\n${shown}`
				: `stdout:\n${shown}`,
		);
	}
	return parts;
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

	if (outcome.capture) {
		parts.push(...describeCapture(outcome.capture, outcome.stdout));
	} else if (outcome.stdout.trim() !== "") {
		parts.push(`stdout:\n${outcome.stdout.trimEnd()}`);
	}

	// stderr comes back whether or not stdout was captured. It is usually small, it
	// is what says why a command failed, and keeping it out of the capture file is
	// what keeps that file parseable by whatever reads it next.
	if (outcome.stderr.trim() !== "") parts.push(`stderr:\n${outcome.stderr.trimEnd()}`);

	if (!outcome.capture && outcome.stdout.trim() === "" && outcome.stderr.trim() === "") {
		parts.push("(no output)");
	}
	if (outcome.truncated && !outcome.capture) {
		parts.push("[output truncated by tin — re-run with narrower arguments to see the rest]");
	}

	return parts.join("\n\n");
}
