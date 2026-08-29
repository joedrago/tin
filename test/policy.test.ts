import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { canonicalize, expandTilde, isInside } from "../src/paths.ts";
import { checkWritePath, decideToolCall } from "../src/policy.ts";
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

test("an empty path is denied rather than resolving to cwd", () => {
	const fx = fixture();
	assert.equal(allowed("write", {}, fx).allow, false);
	assert.equal(allowed("write", { path: "   " }, fx).allow, false);
});
