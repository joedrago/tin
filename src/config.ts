import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize, expandTilde, isInside } from "./paths.ts";

/**
 * Shape of ~/.pi/agent/tin.json. Every field is optional; the defaults are the
 * strict ones, so a missing, malformed, or partially-written config can only ever
 * leave you more restricted than you asked for, never less.
 */
export interface TinConfigFile {
	/** Directory of symlinks to the commands tin_run may execute. Default ~/tinbin */
	binDir?: string;
	/** Directories the model may write into. Default: the session's working directory. */
	writeRoots?: string[];
	/** Path segments that are never writable, at any depth inside a write root. */
	denySegments?: string[];
	/** Extra tool names to allow through the gate (e.g. tools from another extension). */
	allowTools?: string[];
	exec?: {
		timeoutMs?: number;
		maxOutputBytes?: number;
		maxOutputLines?: number;
		/** Ceiling on a captured output file. Far larger than the in-context caps. */
		maxCaptureBytes?: number;
		/** Environment variables copied from pi's own environment into the child. */
		passEnv?: string[];
		/** Environment variables set explicitly on the child. */
		env?: Record<string, string>;
	};
}

export interface TinExecPolicy {
	timeoutMs: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	maxCaptureBytes: number;
	passEnv: string[];
	env: Record<string, string>;
}

export interface TinPolicy {
	/** The session's working directory, canonicalized. */
	workspace: string;
	/** Canonical directories the model may write into. */
	writeRoots: string[];
	/** The subset of writeRoots handed to this session alone, not from the config file. */
	extraWriteRoots: string[];
	/** Segments blocked at any depth inside a write root. */
	denySegments: string[];
	/** Absolute paths (and their subtrees) blocked regardless of write roots. */
	denyPaths: string[];
	/** Where allowed commands are symlinked from. */
	binDir: string;

	// Where a captured command's stdout is written, for the sessions that capture
	// any. The name is settled here and the directory is created on first use, so
	// a session that never captures leaves nothing behind at all.
	captureDir: string;

	/** False when binDir is missing or unsafe; tin_run then refuses everything. */
	execEnabled: boolean;
	/** Extra tool names allowed through the gate. */
	allowTools: string[];
	exec: TinExecPolicy;
	configPath: string;
	/** Problems worth telling the user about at session start. */
	warnings: string[];
}

export const DEFAULT_DENY_SEGMENTS = [".git", ".pi", ".agents"];

const POSIX_PASS_ENV = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

/**
 * The same short list for Windows, where these are not conveniences: a process
 * started without SystemRoot fails somewhere inside the C runtime or the socket
 * stack rather than reporting anything useful, and cmd.exe, PATHEXT, TEMP and the
 * per-user directories are how ordinary programs find themselves at all. Nothing
 * here is a secret; USERPROFILE, APPDATA and LOCALAPPDATA give a program the user's
 * own configuration, which is exactly what HOME already gives it on POSIX.
 */
const WINDOWS_PASS_ENV = [
	"SystemRoot",
	"windir",
	"SystemDrive",
	"ComSpec",
	"PATHEXT",
	"USERPROFILE",
	"USERNAME",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
];

const DEFAULT_PASS_ENV =
	process.platform === "win32" ? [...POSIX_PASS_ENV, ...WINDOWS_PASS_ENV] : POSIX_PASS_ENV;

const DEFAULT_EXEC: TinExecPolicy = {
	timeoutMs: 120_000,
	maxOutputBytes: 100_000,
	maxOutputLines: 2_000,

	// The ceiling on a capture file, which is a different kind of limit from the
	// two above it: those keep a command's output from swamping the conversation,
	// this one only keeps a runaway from filling the disk. It is meant never to be
	// reached in ordinary work, so it is set where a mistake is still caught and a
	// real log is not. In practice exec.timeoutMs binds first for most commands.
	maxCaptureBytes: 4 * 1024 ** 3,

	passEnv: DEFAULT_PASS_ENV,
	env: {},
};

export interface BuildPolicyOptions {
	/** Session working directory. */
	cwd: string;
	/** User home, used to expand `~` and to locate the default binDir. */
	home: string;
	/** pi's agent config directory (~/.pi/agent), where tin.json lives. */
	agentDir: string;
	/**
	 * Write roots for this session only, added to the configured ones rather than
	 * replacing them. `bin/tin` puts the directories from its command line here, by
	 * way of the environment; see TIN_EXTRA_WRITE_ROOTS in src/index.ts.
	 */
	extraWriteRoots?: string[];
	/** Override the config file location (tests). */
	configPath?: string;
	/** Override where captured output would go (tests). */
	captureDir?: string;
	/** Injected for tests. */
	readFile?: (p: string) => string;
	isDirectory?: (p: string) => boolean;
}

/**
 * Name the directory this session would capture output into.
 *
 * It sits under the OS temp directory rather than inside a write root, which
 * settles three things at once: capture adds nothing to what the model may write,
 * a result cannot be rewritten after the fact to say something it did not say,
 * and reads are unrestricted anyway, so tinjs and the read tool reach a capture
 * file without needing a special case for it.
 *
 * Nothing is created here. The name is random rather than derived from the
 * session so that two sessions cannot collide, and the directory is made on the
 * first capture — with mkdir, which fails rather than follows if something is
 * already sitting at the name.
 */
function defaultCaptureDir(): string {
	return path.join(os.tmpdir(), `tin-${randomBytes(9).toString("hex")}`);
}

function defaultIsDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function readConfigFile(
	configPath: string,
	readFile: (p: string) => string,
	warnings: string[],
): TinConfigFile {
	let raw: string;
	try {
		raw = readFile(configPath);
	} catch {
		return {}; // No config file is the normal case.
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`${configPath}: expected a JSON object, ignoring it`);
			return {};
		}
		return parsed as TinConfigFile;
	} catch (error) {
		warnings.push(`${configPath}: ${(error as Error).message} — using defaults`);
		return {};
	}
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string");
	return items.length === value.length ? items : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the effective policy for a session.
 *
 * Config is read only from the user's home directory, never from the project. The
 * model can write inside the project, so a project-local policy file would be a
 * policy the model can edit.
 */
export function buildPolicy(options: BuildPolicyOptions): TinPolicy {
	const {
		cwd,
		home,
		agentDir,
		readFile = (p: string) => readFileSync(p, "utf8"),
		isDirectory = defaultIsDirectory,
	} = options;

	const warnings: string[] = [];
	const configPath = options.configPath ?? path.join(agentDir, "tin.json");
	const file = readConfigFile(configPath, readFile, warnings);

	const workspace = canonicalize(cwd, cwd);

	const configuredRoots = stringArray(file.writeRoots);
	if (file.writeRoots !== undefined && configuredRoots === undefined) {
		warnings.push(`${configPath}: writeRoots must be an array of strings — using the workspace`);
	}
	const rootCandidates = configuredRoots ?? [workspace];
	const writeRoots: string[] = [];
	const addRoot = (candidate: string, label: string): string | undefined => {
		const resolved = canonicalize(expandTilde(candidate, home), cwd);
		if (!isDirectory(resolved)) {
			warnings.push(`${label} ${candidate} is not an existing directory — dropped`);
			return undefined;
		}
		if (!writeRoots.includes(resolved)) writeRoots.push(resolved);
		return resolved;
	};
	for (const candidate of rootCandidates) addRoot(candidate, "writeRoot");

	// Roots granted for this session only, on top of whatever the config resolved to.
	// They are tracked separately as well so the session can say out loud which of its
	// write roots are the temporary ones — a root you granted on a command line an hour
	// ago is exactly the kind of thing worth being reminded of.
	const configured = new Set(writeRoots);
	const extraWriteRoots: string[] = [];
	for (const candidate of options.extraWriteRoots ?? []) {
		const resolved = addRoot(candidate, "extra write root");
		if (resolved !== undefined && !configured.has(resolved) && !extraWriteRoots.includes(resolved)) {
			extraWriteRoots.push(resolved);
		}
	}

	if (writeRoots.length === 0) {
		warnings.push("no usable write roots — all writes will be denied");
	}

	const binDir = canonicalize(expandTilde(file.binDir ?? path.join(home, "tinbin"), home), cwd);

	let execEnabled = true;
	if (!isDirectory(binDir)) {
		execEnabled = false;
		warnings.push(`command directory ${binDir} does not exist — tin_run has nothing to run`);
	}
	// A bin directory the model can write into is not an allowlist, it is a suggestion.
	const writableBin = writeRoots.find((root) => isInside(root, binDir));
	if (writableBin) {
		execEnabled = false;
		warnings.push(
			`command directory ${binDir} is inside writable root ${writableBin} — execution disabled`,
		);
	}

	const denySegments = stringArray(file.denySegments) ?? DEFAULT_DENY_SEGMENTS;

	// Never writable, whatever the roots say: tin's own config and the command
	// allowlist. Both are ways to rewrite the policy rather than to work inside it,
	// and neither is somewhere a session has a reason to be writing.
	//
	// tin's own source is deliberately not on this list. The write roots already say
	// what may be written: if you are working somewhere else, this repository is not
	// a root and is safe by not being one, and if you are working in it, editing it
	// is the entire point of being there.
	// The capture directory joins them. Its contents are how a command's output is
	// handed to the next command, so a session that could rewrite one could launder
	// a result past the person reading the transcript.
	const captureDir = options.captureDir ?? defaultCaptureDir();
	const denyPaths = [configPath, binDir, captureDir];

	const exec: TinExecPolicy = {
		timeoutMs: positiveNumber(file.exec?.timeoutMs, DEFAULT_EXEC.timeoutMs),
		maxOutputBytes: positiveNumber(file.exec?.maxOutputBytes, DEFAULT_EXEC.maxOutputBytes),
		maxOutputLines: positiveNumber(file.exec?.maxOutputLines, DEFAULT_EXEC.maxOutputLines),
		maxCaptureBytes: positiveNumber(file.exec?.maxCaptureBytes, DEFAULT_EXEC.maxCaptureBytes),
		passEnv: stringArray(file.exec?.passEnv) ?? DEFAULT_EXEC.passEnv,
		env: typeof file.exec?.env === "object" && file.exec.env ? file.exec.env : {},
	};

	return {
		workspace,
		writeRoots,
		extraWriteRoots,
		denySegments,
		denyPaths,
		binDir,
		captureDir,
		execEnabled,
		allowTools: stringArray(file.allowTools) ?? [],
		exec,
		configPath,
		warnings,
	};
}
