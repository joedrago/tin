import path from "node:path";
import type { TinPolicy } from "./config.ts";
import { canonicalize, isInside, segmentsWithin } from "./paths.ts";

/** Tools that only observe the filesystem. Unrestricted: it is all local anyway. */
export const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
/** Tools that mutate files. Allowed only inside a write root. */
export const WRITE_TOOLS = new Set(["write", "edit"]);
/** Arbitrary shells. Always denied — tin_run is the only way to run anything. */
export const SHELL_TOOLS = new Set(["bash", "powershell"]);

export const TIN_RUN = "tin_run";

/** The complete set tin exposes to the model, in the order it reads best. */
export function allowedToolNames(policy: TinPolicy): string[] {
	return [...READ_TOOLS, ...WRITE_TOOLS, TIN_RUN, ...policy.allowTools];
}

export type Decision = { allow: true } | { allow: false; reason: string };

const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

function formatRoots(roots: string[]): string {
	return roots.length > 0 ? roots.join(", ") : "(none)";
}

/**
 * Decide whether a path may be written to.
 *
 * `target` is canonicalized first, so symlinks and `..` are already resolved by the
 * time containment is checked.
 */
export function checkWritePath(input: string, policy: TinPolicy, cwd: string): Decision {
	if (typeof input !== "string" || input.trim() === "") {
		return deny("tin: no path given");
	}
	const target = canonicalize(input, cwd);

	for (const denied of policy.denyPaths) {
		if (isInside(denied, target)) {
			return deny(`tin: ${target} is part of tin's own configuration and is never writable`);
		}
	}

	const root = policy.writeRoots.find((candidate) => isInside(candidate, target));
	if (!root) {
		return deny(
			`tin: writing to ${target} is denied — it is outside the writable roots (${formatRoots(policy.writeRoots)}). ` +
				`Note that symlinks are resolved first, so the real destination is what counts.`,
		);
	}

	const segments = segmentsWithin(root, target) ?? [];
	const blocked = segments.find((segment) => policy.denySegments.includes(segment));
	if (blocked) {
		return deny(
			`tin: writing to ${target} is denied — paths containing "${blocked}" are protected inside ${root}`,
		);
	}

	return allow;
}

/**
 * The gate itself. Anything not explicitly recognized is denied, so a tool added by
 * a future pi version or another extension is unavailable until tin is told about it.
 */
export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
	policy: TinPolicy,
	cwd: string,
): Decision {
	if (policy.allowTools.includes(toolName)) return allow;

	if (READ_TOOLS.has(toolName)) return allow;

	if (SHELL_TOOLS.has(toolName)) {
		return deny(
			`tin: the ${toolName} tool is disabled. Use tin_run to execute one of the allowed commands ` +
				`(it takes a command name and an argument array, and runs without a shell).`,
		);
	}

	if (WRITE_TOOLS.has(toolName)) {
		return checkWritePath(typeof input.path === "string" ? input.path : "", policy, cwd);
	}

	if (toolName === TIN_RUN) return allow; // tin_run validates its own arguments.

	return deny(
		`tin: the ${toolName} tool is not part of tin's allowed set. ` +
			`Allowed: ${allowedToolNames(policy).join(", ")}.`,
	);
}

/** One-line summary of the policy, for the status line and /tin. */
export function describePolicy(policy: TinPolicy): string {
	const roots = policy.writeRoots.map((root) => path.basename(root)).join(", ") || "none";
	return `tin: write ${roots} · exec ${policy.execEnabled ? policy.binDir : "off"}`;
}
