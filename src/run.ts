import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { TinPolicy } from "./config.ts";
import { canonicalize, isInside } from "./paths.ts";

/** Command names must be a bare filename in binDir — no paths, no traversal. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

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
	if ((stats.mode & 0o111) === 0) {
		throw new TinDenied(`tin: "${name}" resolves to ${target}, which is not executable.`);
	}

	return { name, link, target };
}

/** Names currently linked in binDir, sorted. Broken and non-executable entries are skipped. */
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
			if (stats.isFile() && (stats.mode & 0o111) !== 0) usable.push(entry);
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

/**
 * Run an allowed command with an argument array. No shell is involved, so the
 * arguments reach the process verbatim: no globbing, no expansion, no redirection,
 * no command substitution. stdin is closed so nothing can wait for input.
 *
 * The child gets its own process group and is killed as a group. Killing only the
 * child leaves its own children running, and they hold the output pipes open, so a
 * timeout would not actually end the call.
 */
export function execCommand(
	command: ResolvedCommand,
	args: string[],
	options: { cwd: string; env: Record<string, string>; policy: TinPolicy; signal?: AbortSignal },
	onData?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<ExecOutcome> {
	const { exec } = options.policy;
	const startedAt = Date.now();

	return new Promise<ExecOutcome>((resolve, reject) => {
		const child = spawn(command.link, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: true,
		});

		const out = capture();
		const err = capture();
		let timedOut = false;
		let settled = false;
		const timers: NodeJS.Timeout[] = [];

		const killGroup = (signal: NodeJS.Signals) => {
			if (settled || child.pid === undefined) return;
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
			timers.push(setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref());
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

		child.on("close", (code, signal) => {
			cleanup();
			const stdout = finish(out, exec.maxOutputLines);
			const stderr = finish(err, exec.maxOutputLines);
			resolve({
				stdout: stdout.text,
				stderr: stderr.text,
				exitCode: code,
				signal,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
				durationMs: Date.now() - startedAt,
			});
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
