import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildPolicy, DEFAULT_DENY_SEGMENTS } from "../src/config.ts";
import { fixture } from "./helpers.ts";

test("defaults are the strict ones", () => {
	const fx = fixture();
	assert.deepEqual(fx.policy.writeRoots, [fx.workspace]);
	assert.equal(fx.policy.binDir, fx.binDir);
	assert.deepEqual(fx.policy.denySegments, DEFAULT_DENY_SEGMENTS);
	assert.deepEqual(fx.policy.allowTools, []);
	assert.equal(fx.policy.execEnabled, true);
	assert.deepEqual(fx.policy.warnings, []);
});

test("the command directory defaults to ~/tinbin", () => {
	const policy = buildPolicy({
		cwd: "/tmp",
		home: "/no-such-root/someone",
		agentDir: "/no-such-root/someone/.pi/agent",
		configPath: "/no-such-root/someone/.pi/agent/does-not-exist.json",
		isDirectory: () => true,
		readFile: () => {
			throw new Error("no config");
		},
	});
	assert.equal(policy.binDir, path.join("/no-such-root/someone", "tinbin"));
});

test("a malformed config falls back to defaults instead of widening them", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		readFile: () => "{ not json",
	});
	assert.deepEqual(policy.writeRoots, [fx.workspace]);
	assert.equal(policy.warnings.length, 1);
	assert.match(policy.warnings[0] ?? "", /using defaults/);
});

test("writeRoots entries that are not directories are dropped with a warning", () => {
	const fx = fixture({ writeRoots: ["~/work", "~/nowhere"] });
	assert.deepEqual(fx.policy.writeRoots, [fx.workspace]);
	assert.equal(fx.policy.warnings.length, 1);
	assert.match(fx.policy.warnings[0] ?? "", /nowhere/);
});

test("extra write roots are added to the configured ones, not swapped in", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		extraWriteRoots: [fx.outside],
	});
	assert.deepEqual(policy.writeRoots, [fx.workspace, fx.outside]);
	assert.deepEqual(policy.extraWriteRoots, [fx.outside]);
	assert.deepEqual(policy.warnings, []);
});

test("an extra write root that is already configured is not reported as extra", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		extraWriteRoots: [fx.workspace, fx.workspace],
	});
	assert.deepEqual(policy.writeRoots, [fx.workspace]);
	assert.deepEqual(policy.extraWriteRoots, []);
});

test("extra write roots that are not directories are dropped with a warning", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		extraWriteRoots: [path.join(fx.root, "nowhere")],
	});
	assert.deepEqual(policy.writeRoots, [fx.workspace]);
	assert.deepEqual(policy.extraWriteRoots, []);
	assert.equal(policy.warnings.length, 1);
	assert.match(policy.warnings[0] ?? "", /extra write root .*nowhere/);
});

test("an extra write root containing binDir disables execution just as a configured one does", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		extraWriteRoots: [fx.home],
	});
	assert.equal(policy.execEnabled, false);
	assert.ok(policy.warnings.some((warning) => /execution disabled/.test(warning)));
});

test("a writable command directory disables execution loudly", () => {
	const fx = fixture({ writeRoots: ["~"] });
	assert.equal(fx.policy.execEnabled, false);
	assert.ok(fx.policy.warnings.some((warning) => /execution disabled/.test(warning)));
});

test("a missing command directory disables execution loudly", () => {
	const fx = fixture({ binDir: "~/not-created" });
	assert.equal(fx.policy.execEnabled, false);
	assert.ok(fx.policy.warnings.some((warning) => /does not exist/.test(warning)));
});

test("exec limits come from config but reject nonsense values", () => {
	const fx = fixture({ exec: { timeoutMs: 5000, maxOutputBytes: -1, passEnv: ["FOO"] } });
	assert.equal(fx.policy.exec.timeoutMs, 5000);
	assert.equal(fx.policy.exec.maxOutputBytes, 100_000);
	assert.deepEqual(fx.policy.exec.passEnv, ["FOO"]);
});
