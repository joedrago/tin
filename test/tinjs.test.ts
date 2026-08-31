import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildChildEnv, execCommand, resolveCommand } from "../src/run.ts";
import { fixture, link } from "./helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(
	repoRoot,
	"tinjs",
	"build",
	process.platform === "win32" ? "tinjs.exe" : "tinjs",
);

/**
 * tinjs is built separately and is not required to be present, so these skip
 * rather than fail when it has not been. `cmake --build tinjs/build` first.
 */
const needsTinjs = { skip: existsSync(binary) ? false : "tinjs is not built" };

/** Run tinjs the way tin_run would: through the allowlist, in tin's child environment. */
async function run(args: string[]) {
	const fx = fixture();
	link(fx, "tinjs", binary);
	const command = resolveCommand("tinjs", fx.policy);
	const outcome = await execCommand(command, args, {
		cwd: fx.workspace,
		env: buildChildEnv(fx.policy, {}),
		policy: fx.policy,
	});
	return { fx, outcome };
}

test("tinjs runs under tin's stripped child environment", needsTinjs, async () => {
	const { outcome } = await run(["-e", "print(1 + 1)"]);
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.stdout.trim(), "2");
	assert.equal(outcome.stderr, "");
});

test("tinjs does the job it is there for", needsTinjs, async () => {
	const { fx } = await run([]);
	const data = path.join(fx.workspace, "log.txt");
	writeFileSync(data, "INFO a\nERROR b\nERROR c\n");

	const command = resolveCommand("tinjs", fx.policy);
	const outcome = await execCommand(
		command,
		[
			"-e",
			`const counts = new Map();
			 for (const line of read(args[0]).trim().split("\\n")) {
			   const level = line.split(" ")[0];
			   counts.set(level, (counts.get(level) ?? 0) + 1);
			 }
			 print(JSON.stringify(Object.fromEntries(counts)));`,
			data,
		],
		{ cwd: fx.workspace, env: buildChildEnv(fx.policy, {}), policy: fx.policy },
	);
	assert.equal(outcome.exitCode, 0);
	assert.deepEqual(JSON.parse(outcome.stdout), { INFO: 1, ERROR: 2 });
});

test("tinjs cannot write, so the write roots are never the thing standing in its way", needsTinjs, async () => {
	const { fx } = await run([]);
	const target = path.join(fx.outside, "escaped.txt");
	const command = resolveCommand("tinjs", fx.policy);

	// Every shape a model might reach for. None of them exist to be called, so
	// each fails inside the interpreter rather than at a policy check.
	for (const attempt of [
		`std.open(${JSON.stringify(target)}, "w").puts("x")`,
		`os.exec(["/bin/sh", "-c", "echo x > ${target}"])`,
		`require("fs").writeFileSync(${JSON.stringify(target)}, "x")`,
		`open(${JSON.stringify(target)}, "w")`,
		`new Function("return this")().std.open(${JSON.stringify(target)}, "w")`,
	]) {
		const outcome = await execCommand(command, ["-e", attempt], {
			cwd: fx.workspace,
			env: buildChildEnv(fx.policy, {}),
			policy: fx.policy,
		});
		assert.equal(outcome.exitCode, 1, attempt);
		assert.match(outcome.stderr, /is not defined|is not a function|cannot read property/, attempt);
		assert.ok(!existsSync(target), `${attempt} created ${target}`);
	}
});

test("a tinjs script that throws is reported as a failure, not as empty output", needsTinjs, async () => {
	const { outcome } = await run(["-e", 'throw new Error("boom")']);
	assert.equal(outcome.exitCode, 1);
	assert.match(outcome.stderr, /boom/);
});

test("an async tinjs script that rejects is reported too", needsTinjs, async () => {
	const { outcome } = await run(["-e", '(async () => { throw new Error("async boom") })()']);
	assert.equal(outcome.exitCode, 1);
	assert.match(outcome.stderr, /async boom/);
});

test("tinjs stops itself before tin's timeout has to", needsTinjs, async () => {
	const { outcome } = await run(["--timeout", "1", "-e", "for (;;) {}"]);
	assert.equal(outcome.exitCode, 1);
	assert.equal(outcome.timedOut, false, "tinjs should stop on its own, not be killed by tin");
	assert.match(outcome.stderr, /timeout/);
});
