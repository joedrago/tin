// The friendly half of tinjs, built on the handful of raw hooks the C side leaves
// in globalThis.__tin. Everything here could have been written in C; none of it
// needed to be, and the C surface is the part that has to be audited, so it stays
// as small as it can be. The hooks are removed from the global object once this
// closure has captured them.
(function () {
	"use strict";

	const raw = globalThis.__tin;
	delete globalThis.__tin;

	const writeOut = raw.write;
	const writeErr = raw.writeErr;

	// How inspect() renders: how deep to descend before printing a placeholder, and
	// the width past which a collection is broken across lines instead of joined.
	const MAX_DEPTH = 4;
	const WRAP_WIDTH = 72;

	function quote(s) {
		const body = s
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\t/g, "\\t");
		return `'${body}'`;
	}

	function wrap(open, parts, close, indent) {
		if (parts.length === 0) return open + close;
		const flat = `${open} ${parts.join(", ")} ${close}`;
		if (flat.length <= WRAP_WIDTH && !flat.includes("\n")) return flat;
		const pad = "  ".repeat(indent + 1);
		return `${open}\n${parts.map((p) => pad + p.replace(/\n/g, `\n${pad}`)).join(",\n")}\n${"  ".repeat(indent)}${close}`;
	}

	function key(k) {
		return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quote(k);
	}

	/**
	 * Render a value the way a person would want to read it in a terminal.
	 *
	 * A top-level string prints as itself, which is what makes console.log("hi")
	 * behave; nested inside a collection it is quoted, so the structure stays
	 * legible. Cycles and depth are both capped rather than allowed to run away.
	 */
	function inspect(value, depth, seen) {
		depth = depth || 0;
		seen = seen || new Set();

		if (value === null) return "null";
		const t = typeof value;
		if (t === "undefined") return "undefined";
		if (t === "boolean") return String(value);
		if (t === "number") return Object.is(value, -0) ? "-0" : String(value);
		if (t === "bigint") return `${value}n`;
		if (t === "symbol") return value.toString();
		if (t === "string") return depth === 0 ? value : quote(value);
		if (t === "function") {
			const name = value.name;
			return name ? `[Function: ${name}]` : "[Function (anonymous)]";
		}

		if (seen.has(value)) return "[Circular]";

		if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
		if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
		if (value instanceof RegExp) return String(value);

		if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

		seen.add(value);
		try {
			if (Array.isArray(value)) {
				const parts = value.map((v) => inspect(v, depth + 1, seen));
				// Trailing properties on an array are worth seeing; they are usually a bug.
				for (const k of Object.keys(value)) {
					if (!/^\d+$/.test(k)) parts.push(`${key(k)}: ${inspect(value[k], depth + 1, seen)}`);
				}
				return wrap("[", parts, "]", depth);
			}
			if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
				const parts = Array.from(value, (v) => inspect(v, depth + 1, seen));
				return `${value.constructor.name}(${value.length}) ${wrap("[", parts, "]", depth)}`;
			}
			if (value instanceof Map) {
				const parts = [];
				for (const [k, v] of value) parts.push(`${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`);
				return `Map(${value.size}) ${wrap("{", parts, "}", depth)}`;
			}
			if (value instanceof Set) {
				const parts = [];
				for (const v of value) parts.push(inspect(v, depth + 1, seen));
				return `Set(${value.size}) ${wrap("{", parts, "}", depth)}`;
			}

			const parts = Object.keys(value).map((k) => `${key(k)}: ${inspect(value[k], depth + 1, seen)}`);
			// A class instance is much easier to place with its name in front of it.
			const ctor = value.constructor;
			const tag = ctor && ctor.name && ctor.name !== "Object" ? `${ctor.name} ` : "";
			return tag + wrap("{", parts, "}", depth);
		} finally {
			seen.delete(value);
		}
	}

	function format(args) {
		let line = "";
		for (let i = 0; i < args.length; i++) {
			if (i > 0) line += " ";
			line += inspect(args[i]);
		}
		return `${line}\n`;
	}

	globalThis.inspect = (value) => inspect(value, 1, new Set());

	globalThis.print = function print(...args) {
		writeOut(format(args));
	};

	globalThis.console = {
		log: globalThis.print,
		info: globalThis.print,
		debug: globalThis.print,
		warn: (...args) => writeErr(format(args)),
		error: (...args) => writeErr(format(args)),
	};

	// The three ways data gets in. There is deliberately no counterpart that puts
	// any back out to disk: stdout is the only channel tinjs writes to.
	globalThis.read = raw.read;
	globalThis.readBytes = raw.readBytes;
	globalThis.readStdin = raw.readStdin;

	globalThis.exit = raw.exit;
	globalThis.args = raw.args;
})();
