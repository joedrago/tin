import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	buildChildEnv,
	execCommand,
	formatOutcome,
	listCommands,
	resolveCommand,
	resolveWorkingDirectory,
	TinDenied,
} from "../src/run.ts";
import { dataFile, fixture, link, script } from "./helpers.ts";

const ECHO = ["/bin/echo", "/usr/bin/echo"].find((candidate) => existsSync(candidate));

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
