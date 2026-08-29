import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` against the given home directory.
 * `~foo` (another user's home) is deliberately left alone.
 */
export function expandTilde(input: string, home: string = os.homedir()): string {
	if (input === "~") return home;
	if (input.startsWith("~/")) return path.join(home, input.slice(2));
	return input;
}

/**
 * Resolve a path the way the built-in tools do, then follow every symlink we can.
 *
 * The target may not exist yet (a write creating a new file), so we walk up to the
 * deepest ancestor that does exist, canonicalize that, and re-append the rest. This
 * is what stops `notes -> /etc` inside the workspace from being a way out: the
 * symlinked ancestor is resolved before containment is checked.
 */
export function canonicalize(input: string, cwd: string): string {
	// Some models include the @ prefix from file mentions in path arguments.
	const cleaned = input.startsWith("@") ? input.slice(1) : input;
	const absolute = path.resolve(cwd, cleaned);

	const trailing: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = realpathSync(current);
			return trailing.length === 0 ? real : path.join(real, ...trailing.slice().reverse());
		} catch {
			const parent = path.dirname(current);
			// Reached the filesystem root without finding anything real.
			if (parent === current) {
				return trailing.length === 0 ? current : path.join(current, ...trailing.slice().reverse());
			}
			trailing.push(path.basename(current));
			current = parent;
		}
	}
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path segments of `target` relative to `root`, or null when it is not inside. */
export function segmentsWithin(root: string, target: string): string[] | null {
	if (!isInside(root, target)) return null;
	const rel = path.relative(root, target);
	return rel === "" ? [] : rel.split(path.sep);
}
