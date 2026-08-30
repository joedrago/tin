import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	buildChildEnv,
	buildLaunch,
	execCommand,
	formatOutcome,
	listCommands,
	quoteForCmd,
	resolveCommand,
	resolveWorkingDirectory,
	TinDenied,
} from "../src/run.ts";
import { dataFile, fixture, link, script } from "./helpers.ts";

const ECHO = ["/bin/echo", "/usr/bin/echo"].find((candidate) => existsSync(candidate));

/** Marks a test that only means anything on Windows. */
const windowsOnly = { skip: process.platform === "win32" ? false : "Windows only" };

test("only names linked into the command directory resolve", () => {
	const fx = fixture();
	assert.ok(ECHO, "no echo binary to link");
	link(fx, "echo", ECHO);

	const resolved = resolveCommand("echo", fx.policy);
	assert.equal(resolved.link, path.join(fx.binDir, "echo"));
	// The target is fully canonical: /bin/echo is itself a symlink on many systems.
	assert.equal(resolved.target, realpathSync(ECHO));

	assert.throws(() => resolveCommand("cat", fx.policy), TinDenied);
});

test("command names cannot be paths", () => {
	const fx = fixture();
	assert.ok(ECHO);
	link(fx, "echo", ECHO);

	for (const name of ["/bin/sh", "../../bin/sh", "sub/echo", "..", ".", "", "echo;sh"]) {
		assert.throws(() => resolveCommand(name, fx.policy), TinDenied, name);
	}
});

test("broken links and non-executables are refused", () => {
	const fx = fixture();
	link(fx, "ghost", path.join(fx.outside, "does-not-exist"));
	dataFile(fx, "notes", "just data\n");

	assert.throws(() => resolveCommand("ghost", fx.policy), TinDenied);
	// Windows has no executable bit, so being linked in is the whole decision there.
	if (process.platform === "win32") {
		assert.equal(resolveCommand("notes", fx.policy).name, "notes");
	} else {
		assert.throws(() => resolveCommand("notes", fx.policy), TinDenied);
	}
});

test("listCommands reports what is usable and nothing else", () => {
	const fx = fixture();
	assert.ok(ECHO);
	link(fx, "echo", ECHO);
	link(fx, "ghost", path.join(fx.outside, "does-not-exist"));
	assert.deepEqual(listCommands(fx.policy), ["echo"]);
});

test("execution is disabled when the command directory is writable", () => {
	const fx = fixture({ writeRoots: ["~"] });
	assert.equal(fx.policy.execEnabled, false);
	assert.deepEqual(listCommands(fx.policy), []);
	assert.throws(() => resolveCommand("echo", fx.policy), TinDenied);
});

test("the child environment carries no secrets and only sees allowed commands", () => {
	const fx = fixture();
	const env = buildChildEnv(fx.policy, {
		HOME: fx.home,
		PATH: "/usr/bin:/bin",
		ANTHROPIC_API_KEY: "sk-should-not-leak",
		AWS_SECRET_ACCESS_KEY: "nope",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
	});

	assert.equal(env.PATH, fx.binDir);
	assert.equal(env.HOME, fx.home);
	assert.equal(env.TERM, "dumb");
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.SSH_AUTH_SOCK, undefined);
});

test("the working directory must stay inside a write root", () => {
	const fx = fixture();
	assert.equal(resolveWorkingDirectory(undefined, fx.policy, fx.workspace), fx.workspace);
	assert.equal(
		resolveWorkingDirectory("sub", fx.policy, fx.workspace),
		path.join(fx.workspace, "sub"),
	);
	assert.throws(() => resolveWorkingDirectory("/etc", fx.policy, fx.workspace), TinDenied);
	assert.throws(() => resolveWorkingDirectory("escape", fx.policy, fx.workspace), TinDenied);
});

test("arguments reach the process verbatim, with no shell interpretation", async () => {
	const fx = fixture();
	assert.ok(ECHO);
	link(fx, "echo", ECHO);

	const outcome = await execCommand(
		resolveCommand("echo", fx.policy),
		["a b", "$HOME", "*", "|", "&&", "$(id)"],
		{ cwd: fx.workspace, env: buildChildEnv(fx.policy), policy: fx.policy },
	);

	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.stdout, "a b $HOME * | && $(id)\n");
});

test("quoteForCmd escapes one layer of cmd metacharacters per pass", () => {
	assert.equal(quoteForCmd("plain", 0), '"plain"');
	assert.equal(quoteForCmd("plain", 1), '^"plain^"');
	assert.equal(quoteForCmd("plain", 2), '^^^"plain^^^"');
	// A quote is escaped for the C runtime, and the backslashes before one doubled.
	assert.equal(quoteForCmd('say "hi"', 0), '"say \\"hi\\""');
	assert.equal(quoteForCmd("trail\\", 0), '"trail\\\\"');
	assert.equal(quoteForCmd("a\\\\\\", 0), '"a\\\\\\\\\\\\"');
	// %NAME% only survives because the carets break the shape cmd looks for.
	assert.equal(quoteForCmd("%PATH%", 1), '^"^%PATH^%^"');
});

test("a .bat is launched through cmd, a .mjs through node, anything else directly", windowsOnly, () => {
	const fx = fixture();
	const direct = buildLaunch(
		{ name: "tool.exe", link: path.join(fx.binDir, "tool.exe"), target: "x" },
		["a b"],
	);
	assert.equal(direct.file, path.join(fx.binDir, "tool.exe"));
	assert.deepEqual(direct.args, ["a b"]);
	assert.equal(direct.verbatim, false);

	// The interpreter is the node tin is itself running on, not one looked up on PATH.
	const script = path.join(fx.binDir, "tool.mjs");
	const viaNode = buildLaunch({ name: "tool.mjs", link: script, target: script }, ["a b", "&"]);
	assert.equal(viaNode.file, process.execPath);
	assert.deepEqual(viaNode.args, [script, "a b", "&"]);
	assert.equal(viaNode.verbatim, false);

	const entry = path.join(fx.binDir, "tool.bat");
	const batch = buildLaunch({ name: "tool.bat", link: entry, target: entry }, ["a b"]);
	assert.match(batch.file, /cmd\.exe$/i);
	assert.equal(batch.verbatim, true);
	assert.deepEqual(batch.args.slice(0, 3), ["/d", "/s", "/c"]);
	// The path is parsed once; the argument is parsed again on the line %* expands into.
	assert.equal(batch.args[3], `"${quoteForCmd(entry, 1)} ${quoteForCmd("a b", 2)}"`);
});

test("a .bat entry runs, and cmd's metacharacters reach it as literals", windowsOnly, async () => {
	const fx = fixture();
	// The batch forwards to node, which reports its argv exactly as it received it.
	// Echoing from cmd itself could not tell a mangled argument from a mangled echo.
	dataFile(fx, "argv.mjs", "console.log(JSON.stringify(process.argv.slice(2)));\n");
	script(fx, "argv.bat", '@echo off\r\n"%TIN_TEST_NODE%" "%TIN_TEST_DUMP%" %*\r\n');

	const args = [
		"a b",
		"&",
		"|",
		"<",
		">",
		"^",
		"(",
		")",
		"!",
		"*",
		"%PATH%",
		"%%",
		'say "hi"',
		"trail\\",
		"--pretty=format:%h %s",
		"",
	];
	const outcome = await execCommand(resolveCommand("argv.bat", fx.policy), args, {
		cwd: fx.workspace,
		env: {
			...buildChildEnv(fx.policy),
			SystemRoot: process.env.SystemRoot ?? "",
			TIN_TEST_NODE: process.execPath,
			TIN_TEST_DUMP: path.join(fx.binDir, "argv.mjs"),
		},
		policy: fx.policy,
	});

	assert.equal(outcome.exitCode, 0, outcome.stderr);
	assert.deepEqual(JSON.parse(outcome.stdout.trim()), args);
});

test("a .mjs entry runs, and gets its arguments as argv", windowsOnly, async () => {
	const fx = fixture();
	script(fx, "argv.mjs", "console.log(JSON.stringify(process.argv.slice(2)));\n");

	// Including the shapes node would otherwise read as its own options.
	const args = ["--version", "-e", "console.log(1)", "a b", "&", '"', "\\", ""];
	const outcome = await execCommand(resolveCommand("argv.mjs", fx.policy), args, {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.equal(outcome.exitCode, 0, outcome.stderr);
	assert.deepEqual(JSON.parse(outcome.stdout.trim()), args);
});

test("exit codes and stderr come back intact", async () => {
	const fx = fixture();
	script(fx, "fail", "#!/bin/sh\necho oops >&2\nexit 3\n");

	const outcome = await execCommand(resolveCommand("fail", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.equal(outcome.exitCode, 3);
	assert.equal(outcome.stderr.trim(), "oops");
	assert.match(formatOutcome("fail", [], outcome), /exited with code 3/);
});

test("a child process only finds allowed commands on PATH", async () => {
	const fx = fixture();
	script(fx, "sneak", "#!/bin/sh\nid\n");

	const outcome = await execCommand(resolveCommand("sneak", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.notEqual(outcome.exitCode, 0);
	assert.match(outcome.stderr, /not found/i);
});

test("output past the byte limit is truncated and flagged", async () => {
	const fx = fixture();
	script(
		fx,
		"flood",
		"#!/bin/sh\ni=0\nwhile [ $i -lt 500 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done\n",
	);
	fx.policy.exec.maxOutputBytes = 200;

	const outcome = await execCommand(resolveCommand("flood", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.ok(outcome.truncated);
	assert.ok(Buffer.byteLength(outcome.stdout) <= 200);
	assert.match(formatOutcome("flood", [], outcome), /output truncated by tin/);
});

test("a command that outlives its timeout is killed", async () => {
	const fx = fixture();
	// sleep has to be linked too: the child's PATH is the allowlist directory.
	const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((candidate) => existsSync(candidate));
	assert.ok(sleep, "no sleep binary to link");
	link(fx, "sleep", sleep);
	script(fx, "sleeper", "#!/bin/sh\nsleep 30\n");
	fx.policy.exec.timeoutMs = 250;

	const outcome = await execCommand(resolveCommand("sleeper", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.equal(outcome.timedOut, true);
	assert.notEqual(outcome.signal, null);
	assert.match(formatOutcome("sleeper", [], outcome), /tin timeout/);
	// The grandchild `sleep` is killed with the group, so the call does not wait it out.
	assert.ok(outcome.durationMs < 5_000, `took ${outcome.durationMs}ms`);
});

test("aborting the turn kills the command and its children", async () => {
	const fx = fixture();
	const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((candidate) => existsSync(candidate));
	assert.ok(sleep, "no sleep binary to link");
	link(fx, "sleep", sleep);
	script(fx, "sleeper", "#!/bin/sh\nsleep 30\n");

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const started = Date.now();

	const outcome = await execCommand(resolveCommand("sleeper", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
		signal: controller.signal,
	});

	assert.equal(outcome.timedOut, false);
	assert.notEqual(outcome.signal, null);
	assert.ok(Date.now() - started < 5_000);
});

test("a grandchild left holding the pipes does not hold up the call", async () => {
	const fx = fixture();
	const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((candidate) => existsSync(candidate));
	assert.ok(sleep, "no sleep binary to link");
	link(fx, "sleep", sleep);
	// The script exits immediately, but the sleep it leaves behind inherited stdout
	// and holds the pipe open — and "close" waits on the pipes, not just the process.
	script(fx, "daemonize", "#!/bin/sh\nsleep 10 &\necho started\n");
	fx.policy.exec.timeoutMs = 10_000;

	const outcome = await execCommand(resolveCommand("daemonize", fx.policy), [], {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy),
		policy: fx.policy,
	});

	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.timedOut, false);
	assert.equal(outcome.stdout.trim(), "started");
	assert.ok(outcome.durationMs < 5_000, `took ${outcome.durationMs}ms`);
});
