import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { canonicalize, expandTilde, isInside } from "../src/paths.ts";
import { buildPolicy } from "../src/config.ts";
import { checkWritePath, decideToolCall, describeTinjs, describeWriteRoots } from "../src/policy.ts";
import { fixture } from "./helpers.ts";

function allowed(name: string, input: Record<string, unknown>, fx = fixture()) {
	return decideToolCall(name, input, fx.policy, fx.workspace);
}

test("expandTilde only expands the current user's home", () => {
	assert.equal(expandTilde("~/x", "/home/joe"), "/home/joe/x");
	assert.equal(expandTilde("~", "/home/joe"), "/home/joe");
	assert.equal(expandTilde("~root/x", "/home/joe"), "~root/x");
	assert.equal(expandTilde("/abs", "/home/joe"), "/abs");
});

test("canonicalize resolves symlinked ancestors of paths that do not exist yet", () => {
	const fx = fixture();
	const through = canonicalize("escape/new-file.txt", fx.workspace);
	assert.equal(through, path.join(fx.outside, "new-file.txt"));
});

test("canonicalize strips a leading @ and resolves .. against cwd", () => {
	const fx = fixture();
	assert.equal(canonicalize("@notes.md", fx.workspace), path.join(fx.workspace, "notes.md"));
	assert.equal(canonicalize("../outside", fx.workspace), path.join(fx.home, "outside"));
});

test("isInside treats a root as containing itself but not its siblings", () => {
	assert.ok(isInside("/a/b", "/a/b"));
	assert.ok(isInside("/a/b", "/a/b/c"));
	assert.ok(!isInside("/a/b", "/a/bc"));
	assert.ok(!isInside("/a/b", "/a"));
});

test("reads are allowed anywhere", () => {
	const fx = fixture();
	for (const tool of ["read", "ls", "grep", "find"]) {
		assert.deepEqual(allowed(tool, { path: "/etc/passwd" }, fx), { allow: true });
	}
});

test("shells are always denied and point at tin_run", () => {
	const fx = fixture();
	for (const tool of ["bash", "powershell"]) {
		const decision = allowed(tool, { command: "ls" }, fx);
		assert.equal(decision.allow, false);
		assert.match(decision.allow === false ? decision.reason : "", /tin_run/);
	}
});

test("unknown tools are denied by default", () => {
	const decision = allowed("web_fetch", { url: "https://example.com" });
	assert.equal(decision.allow, false);
	assert.match(decision.allow === false ? decision.reason : "", /not part of tin's allowed set/);
});

test("allowTools opens a named tool without opening the rest", () => {
	const fx = fixture({ allowTools: ["todo"] });
	assert.deepEqual(allowed("todo", {}, fx), { allow: true });
	assert.equal(allowed("web_fetch", {}, fx).allow, false);
});

test("writes inside the workspace are allowed", () => {
	const fx = fixture();
	for (const target of ["notes.md", "./src/deep/new.ts", `${fx.workspace}/abs.txt`]) {
		assert.deepEqual(allowed("write", { path: target }, fx), { allow: true }, target);
	}
});

test("writes outside the workspace are denied", () => {
	const fx = fixture();
	for (const target of ["/etc/passwd", "../outside/x", `${fx.home}/.bashrc`]) {
		assert.equal(allowed("write", { path: target }, fx).allow, false, target);
	}
});

test("a symlink out of the workspace is not a way out", () => {
	const fx = fixture();
	const decision = allowed("edit", { path: "escape/secret.txt" }, fx);
	assert.equal(decision.allow, false);
	assert.match(decision.allow === false ? decision.reason : "", /outside the writable roots/);
});

test("protected segments are denied at any depth", () => {
	const fx = fixture();
	for (const target of [".git/config", "sub/.git/hooks/pre-commit", ".pi/extensions/evil.ts"]) {
		const decision = allowed("write", { path: target }, fx);
		assert.equal(decision.allow, false, target);
		assert.match(decision.allow === false ? decision.reason : "", /protected/);
	}
});

test("tin's own config and command directory are never writable", () => {
	const fx = fixture({ writeRoots: ["~"] });
	for (const target of [fx.policy.configPath, path.join(fx.binDir, "sh")]) {
		const decision = checkWritePath(target, fx.policy, fx.workspace);
		assert.equal(decision.allow, false, target);
		assert.match(decision.allow === false ? decision.reason : "", /never writable/);
	}
});

test("tin's own source is writable when it is where you are working", () => {
	// tin used to protect its own directory unconditionally. It no longer does, and
	// does not need to: the write roots already answer the question, and a session
	// pointed at this repository is one that means to edit it.
	const fx = fixture();
	assert.deepEqual(fx.policy.denyPaths, [fx.policy.configPath, fx.binDir]);
	assert.equal(checkWritePath(path.join(fx.workspace, "src", "policy.ts"), fx.policy, fx.workspace).allow, true);
});

test("a directory that is not a write root needs no special case to stay unwritable", () => {
	const fx = fixture();
	const decision = checkWritePath(path.join(fx.outside, "src", "policy.ts"), fx.policy, fx.workspace);
	assert.equal(decision.allow, false);
	assert.match(decision.allow === false ? decision.reason : "", /outside the writable roots/);
});

test("an empty path is denied rather than resolving to cwd", () => {
	const fx = fixture();
	assert.equal(allowed("write", {}, fx).allow, false);
	assert.equal(allowed("write", { path: "   " }, fx).allow, false);
});

test("the session banner marks the roots that are only there for this session", () => {
	const fx = fixture();
	const policy = buildPolicy({
		cwd: fx.workspace,
		home: fx.home,
		agentDir: fx.agentDir,
		configPath: fx.policy.configPath,
		extraWriteRoots: [fx.outside],
	});
	const banner = describeWriteRoots(policy);
	assert.match(banner, new RegExp(`${fx.workspace}\\s*$`, "m"));
	assert.match(banner, new RegExp(`${fx.outside}\\s+\\(this session only\\)`));
});

test("the session banner says nothing is writable rather than listing an empty set", () => {
	const fx = fixture({ writeRoots: [] });
	assert.match(describeWriteRoots(fx.policy), /nothing is writable/);
});

test("the tinjs blurb appears only when tinjs is actually linked", () => {
	assert.deepEqual(describeTinjs([]), []);
	assert.deepEqual(describeTinjs(["git", "rg", "jq"]), []);
	// A name that merely starts with tinjs is a different command.
	assert.deepEqual(describeTinjs(["tinjs-old", "tinjsx"]), []);

	const blurb = describeTinjs(["git", "tinjs"]).join("\n");
	assert.match(blurb, /`tinjs` is a JavaScript interpreter/);
});

test("the tinjs blurb calls the command by the name it is linked under", () => {
	// Windows entries carry the extension, and that is the name the model must use.
	const blurb = describeTinjs(["rg.exe", "tinjs.exe"]).join("\n");
	assert.match(blurb, /command: "tinjs\.exe"/);
	assert.ok(!blurb.includes('command: "tinjs"'));
});

test("the tinjs blurb states what is not there, so the model does not go looking", () => {
	const blurb = describeTinjs(["tinjs"]).join("\n");
	for (const capability of ["write a file", "reach the network", "run a program", "read the environment", "import a module"]) {
		assert.ok(blurb.includes(capability), `blurb should rule out: ${capability}`);
	}
	// And what it does have, since that is what saves the wasted first attempt.
	for (const api of ["read(path)", "readBytes(path)", "readStdin()", "print(...)", "exit(code)"]) {
		assert.ok(blurb.includes(api), `blurb should offer: ${api}`);
	}
});

test("the tinjs blurb does not describe limits tinjs no longer imposes", () => {
	// The memory and time caps are off by default; a model told about a 60s budget
	// would size its work to a bound that is not there.
	const blurb = describeTinjs(["tinjs"]).join("\n");
	assert.doesNotMatch(blurb, /\b60s\b|\b256\s?MB\b|\bLimits are\b/i);
});
