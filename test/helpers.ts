import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPolicy, type TinPolicy } from "../src/config.ts";

export interface Fixture {
	root: string;
	home: string;
	agentDir: string;
	workspace: string;
	binDir: string;
	outside: string;
	policy: TinPolicy;
}

/**
 * Build a throwaway home + workspace:
 *
 *   <root>/home/tinbin/        allowlist directory
 *   <root>/home/work/          the workspace (write root)
 *   <root>/home/work/escape -> <root>/outside   a symlink out of the workspace
 *   <root>/outside/            everything the model must not reach
 */
export function fixture(config?: Record<string, unknown>): Fixture {
	const root = mkdtempSync(path.join(os.tmpdir(), "tin-test-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const workspace = path.join(home, "work");
	const binDir = path.join(home, "tinbin");
	const outside = path.join(root, "outside");

	for (const dir of [agentDir, workspace, binDir, outside, path.join(workspace, ".git")]) {
		mkdirSync(dir, { recursive: true });
	}
	symlinkSync(outside, path.join(workspace, "escape"));
	writeFileSync(path.join(outside, "secret.txt"), "secret\n");

	const configPath = path.join(agentDir, "tin.json");
	if (config) writeFileSync(configPath, JSON.stringify(config));

	const policy = buildPolicy({ cwd: workspace, home, agentDir, configPath, selfDir: undefined });
	return { root, home, agentDir, workspace, binDir, outside, policy };
}

/** Link a real executable into the fixture's allowlist directory. */
export function link(fx: Fixture, name: string, target: string): void {
	symlinkSync(target, path.join(fx.binDir, name));
}

/** Write an executable script into the fixture's allowlist directory. */
export function script(fx: Fixture, name: string, body: string): void {
	writeFileSync(path.join(fx.binDir, name), body, { mode: 0o755 });
}

/** Write a non-executable file into the fixture's allowlist directory. */
export function dataFile(fx: Fixture, name: string, body: string): void {
	writeFileSync(path.join(fx.binDir, name), body, { mode: 0o644 });
}
