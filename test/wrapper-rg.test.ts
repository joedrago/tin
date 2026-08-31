import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error - the wrapper is plain JavaScript, deliberately: it has to stay
// runnable straight out of the allowlist directory, with nothing compiled first.
import { childEnv, Refused, rgPolicy } from "../wrappers/rg.mjs";

/** The argument list the wrapper would hand to rg. */
function allowed(...argv: string[]): string[] {
	return rgPolicy(argv) as string[];
}

function refused(...argv: string[]): string {
	try {
		rgPolicy(argv);
	} catch (error) {
		assert.ok(error instanceof Refused, `expected a refusal, got ${error}`);
		return (error as Error).message;
	}
	return assert.fail(`${argv.join(" ")} was allowed through`);
}

test("ordinary searching passes through untouched", () => {
	assert.deepEqual(allowed("-n", "TODO", "src"), ["-n", "TODO", "src"]);
	assert.deepEqual(allowed("--json", "-g", "*.ts", "pattern"), ["--json", "-g", "*.ts", "pattern"]);
	assert.deepEqual(allowed("-l", "--no-ignore", "x"), ["-l", "--no-ignore", "x"]);
	// The flags that only look alarming: these read, they do not run anything.
	assert.deepEqual(allowed("--files", "--stats", "--debug"), ["--files", "--stats", "--debug"]);
	assert.deepEqual(allowed("--ignore-file", ".ignore", "x"), ["--ignore-file", ".ignore", "x"]);
});

test("the flags that hand rg a program to run are refused", () => {
	for (const argv of [
		["--pre", "/bin/sh", "x"],
		["--pre=/bin/sh", "x"],
		["--pre-glob", "*", "x"],
		["--pre-glob=*", "x"],
		["--hostname-bin", "/bin/sh", "x"],
		["--hostname-bin=/bin/sh", "x"],
	]) {
		refused(...argv);
	}
});

test("a dangerous flag is caught wherever it sits in the line", () => {
	refused("-n", "TODO", "src", "--pre", "/bin/sh");
	refused("-i", "--pre=/bin/sh", "-n", "x");
});

test("an abbreviation is refused in both directions", () => {
	// rg rejects abbreviations itself today, so the second of these is a guard
	// against a parser that starts accepting them rather than a live hole.
	assert.match(refused("--pre-glob-something", "x"), /not allowed/);
	assert.match(refused("--pr", "x"), /may expand to --pre/);
});

test("everything after -- is a pattern, not a flag", () => {
	assert.deepEqual(allowed("-F", "--", "--pre"), ["-F", "--", "--pre"]);
	assert.deepEqual(allowed("--", "--hostname-bin", "file.txt"), ["--", "--hostname-bin", "file.txt"]);
});

test("the config file that could name --pre is taken out of the environment", () => {
	const env = childEnv({ RIPGREP_CONFIG_PATH: "/tmp/evil", HOME: "/home/you" }) as Record<string, string>;
	assert.equal(env.RIPGREP_CONFIG_PATH, undefined);
	assert.equal(env.HOME, "/home/you");
});
