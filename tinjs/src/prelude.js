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

	/**
	 * Walk a file one line at a time, without holding it all in memory.
	 *
	 * Each call opens the file and returns its own iterator, so two walks of the
	 * same path do not interfere and starting again from the top is just calling
	 * lines() again — there is no rewind, and no shared position to corrupt. The
	 * handle stays captured in here: what the caller gets is an iterator and
	 * nothing else, so there is no object with a file behind it loose in the
	 * script.
	 *
	 * The file is closed when the last line has been read, and when a for..of
	 * loop is left early — break, return and throw all reach return() through the
	 * iterator protocol. An iterator that is simply abandoned is closed when it is
	 * collected, and at worst when the process exits.
	 */
	globalThis.lines = function lines(path) {
		const handle = raw.openLines(path);
		let done = false;
		return {
			next() {
				if (done) return { value: undefined, done: true };
				const line = raw.nextLine(handle);
				if (line === null) {
					done = true;
					return { value: undefined, done: true };
				}
				return { value: line, done: false };
			},
			return(value) {
				if (!done) {
					done = true;
					raw.closeLines(handle);
				}
				return { value, done: true };
			},
			[Symbol.iterator]() {
				return this;
			},
		};
	};

	// The ways data gets in. There is deliberately no counterpart that puts any
	// back out to disk: stdout is the only channel tinjs writes to.
	globalThis.read = raw.read;
	globalThis.readBytes = raw.readBytes;

	/**
	 * Answer size, modtime and kind for a path without reading it — the thing to
	 * call before deciding whether a `read`, a `readBytes` slice, or nothing at
	 * all is the right next move on a file that might be huge or might not even
	 * be a file.
	 */
	globalThis.stat = function stat(path) {
		const raw_stat = raw.stat(path);
		return {
			size: raw_stat.size,
			mtime: new Date(raw_stat.mtimeMs),
			isDirectory: raw_stat.isDirectory,
			isFile: raw_stat.isFile,
			isSymlink: raw_stat.isSymlink,
		};
	};

	function byName(a, b) {
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	}

	/**
	 * The entries of one directory, sorted by name so that two runs over the
	 * same tree print the same thing. Each is `{ name, isDirectory, isFile,
	 * isSymlink }`; the first two describe what a link points at.
	 */
	globalThis.readdir = function readdir(path) {
		return raw.readdir(path).sort(byName);
	};

	/**
	 * Every entry below `root`, depth-first, as `{ path, name, isDirectory,
	 * isFile, isSymlink }` with `path` joined onto `root`. It is a generator, so
	 * a tree of any size is walked without being held, and leaving the loop early
	 * stops it. Symlinked directories are reported but not entered, which is what
	 * keeps a link back up the tree from being a loop; a subdirectory that cannot
	 * be listed is reported and skipped rather than ending the walk.
	 */
	globalThis.walk = function* walk(root) {
		const base = root.endsWith("/") ? root : `${root}/`;
		for (const entry of readdir(root)) {
			const path = base + entry.name;
			yield { path, ...entry };
			if (entry.isDirectory && !entry.isSymlink) {
				try {
					yield* walk(path);
				} catch (e) {
					if (!(e instanceof InternalError) || !String(e.message).startsWith("cannot list")) throw e;
				}
			}
		}
	};

	globalThis.readlink = raw.readlink;

	// --------------------------------------------------------- bytes in, bytes out
	//
	// Everything below is computation on values the script already has. None of
	// it reads or writes anything; the C side of each takes one Uint8Array, so
	// the other shapes bytes arrive in are turned into one here first.

	/** A string (as UTF-8), an ArrayBuffer, or any typed array or DataView, as a Uint8Array. */
	function toBytes(data, who) {
		if (typeof data === "string") return raw.utf8Encode(data.toWellFormed());
		if (data instanceof Uint8Array) return data;
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		throw new TypeError(`${who}() needs a string, an ArrayBuffer or a typed array`);
	}

	function concat(parts) {
		if (parts.length === 1) return parts[0];
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}

	function u32le(b, at) {
		return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
	}

	globalThis.md5 = (data) => raw.md5(toBytes(data, "md5"));
	globalThis.sha1 = (data) => raw.sha1(toBytes(data, "sha1"));
	globalThis.sha256 = (data) => raw.sha256(toBytes(data, "sha256"));
	globalThis.crc32 = (data) => raw.crc32(toBytes(data, "crc32"));
	globalThis.adler32 = (data) => raw.adler32(toBytes(data, "adler32"));

	// zlib's names and zlib's formats: deflate/inflate are the zlib-wrapped
	// stream (what HTTP calls "deflate" and what PNG and git objects hold), the
	// Raw pair is the bare stream (what is inside a zip entry), and gzip/gunzip
	// are .gz files. The level is zlib's 0–9, 6 by default.
	globalThis.deflate = (data, level = 6) => raw.deflate(toBytes(data, "deflate"), level, true);
	globalThis.deflateRaw = (data, level = 6) => raw.deflate(toBytes(data, "deflateRaw"), level, false);
	globalThis.inflate = (data) => raw.inflate(toBytes(data, "inflate"), true)[0];
	globalThis.inflateRaw = (data) => raw.inflate(toBytes(data, "inflateRaw"), false)[0];

	globalThis.gzip = function gzip(data, level = 6) {
		const bytes = toBytes(data, "gzip");
		const body = raw.deflate(bytes, level, false);
		const out = new Uint8Array(10 + body.length + 8);
		// Magic, deflate, no flags, no mtime, no extra flags, OS "unknown".
		out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
		out.set(body, 10);
		const view = new DataView(out.buffer);
		view.setUint32(10 + body.length, raw.crc32(bytes), true);
		view.setUint32(14 + body.length, bytes.length >>> 0, true);
		return out;
	};

	/**
	 * Decompress a .gz file's bytes. Concatenated members come back as one
	 * buffer, as gzip -d would give them, and each member's CRC and length are
	 * checked against its trailer. Anything after the last member that is not
	 * another member is ignored, the same as gzip's "trailing garbage".
	 */
	globalThis.gunzip = function gunzip(data) {
		const b = toBytes(data, "gunzip");
		const parts = [];
		let at = 0;
		const truncated = () => new Error("gunzip(): data is truncated");
		do {
			if (b[at] !== 0x1f || b[at + 1] !== 0x8b) throw new Error("gunzip(): not gzip data");
			if (b[at + 2] !== 8) throw new Error("gunzip(): not a deflate gzip member");
			const flags = b[at + 3];
			at += 10;
			if (flags & 4) at += 2 + (b[at] | (b[at + 1] << 8)); // FEXTRA
			for (const bit of [8, 16]) {
				// FNAME, FCOMMENT: zero-terminated
				if (!(flags & bit)) continue;
				const end = b.indexOf(0, at);
				if (end < 0) throw truncated();
				at = end + 1;
			}
			if (flags & 2) at += 2; // FHCRC
			if (at > b.length) throw truncated();

			const [out, used] = raw.inflate(b.subarray(at), false);
			at += used;
			if (at + 8 > b.length) throw truncated();
			if (u32le(b, at) !== raw.crc32(out) || u32le(b, at + 4) !== out.length >>> 0) {
				throw new Error("gunzip(): checksum mismatch");
			}
			at += 8;
			parts.push(out);
		} while (b[at] === 0x1f && b[at + 1] === 0x8b);
		return concat(parts);
	};

	// windows-1252's 0x80–0x9F, which is where it parts from ISO-8859-1. The web
	// decodes "latin1" and "iso-8859-1" as windows-1252, and so does this.
	const CP1252 = [
		0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
		0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
		0x153, 0x9d, 0x17e, 0x178,
	];

	const ENCODINGS = {
		"utf-8": "utf-8",
		utf8: "utf-8",
		"unicode-1-1-utf-8": "utf-8",
		"utf-16": "utf-16le",
		"utf-16le": "utf-16le",
		"utf-16be": "utf-16be",
		latin1: "windows-1252",
		"iso-8859-1": "windows-1252",
		"windows-1252": "windows-1252",
		ascii: "windows-1252",
		"us-ascii": "windows-1252",
	};

	function fromCodes(codes) {
		let s = "";
		for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode.apply(null, codes.subarray(i, i + 8192));
		return s;
	}

	globalThis.TextEncoder = class TextEncoder {
		get encoding() {
			return "utf-8";
		}
		encode(input = "") {
			return raw.utf8Encode(String(input).toWellFormed());
		}
	};

	/**
	 * Bytes to a string, in UTF-8, UTF-16 (either order) or windows-1252. A
	 * leading byte-order mark is dropped unless `ignoreBOM` is set; malformed
	 * input becomes U+FFFD, or throws a TypeError when `fatal` is set.
	 */
	globalThis.TextDecoder = class TextDecoder {
		#encoding;
		#fatal;
		#ignoreBOM;

		constructor(label = "utf-8", options = {}) {
			const encoding = ENCODINGS[String(label).trim().toLowerCase()];
			if (!encoding) throw new RangeError(`TextDecoder: unsupported encoding ${label}`);
			this.#encoding = encoding;
			this.#fatal = Boolean(options.fatal);
			this.#ignoreBOM = Boolean(options.ignoreBOM);
		}

		get encoding() {
			return this.#encoding;
		}
		get fatal() {
			return this.#fatal;
		}
		get ignoreBOM() {
			return this.#ignoreBOM;
		}

		decode(input) {
			if (input === undefined) return "";
			if (typeof input === "string") throw new TypeError("TextDecoder.decode() needs bytes, not a string");
			const b = toBytes(input, "decode");
			let s;
			let bad = false;

			if (this.#encoding === "utf-8") {
				s = raw.utf8Decode(b);
				// quickjs decodes an encoded surrogate (ED A0 80) to a lone one
				// rather than to U+FFFD, so that is checked separately. Otherwise,
				// valid UTF-8 is exactly the input that survives a round trip.
				bad = !s.isWellFormed();
				if (this.#fatal && !bad) {
					const back = raw.utf8Encode(s);
					bad = back.length !== b.length || back.some((v, i) => v !== b[i]);
				}
				s = s.toWellFormed();
			} else if (this.#encoding === "windows-1252") {
				const codes = new Uint16Array(b.length);
				for (let i = 0; i < b.length; i++) {
					const v = b[i];
					codes[i] = v >= 0x80 && v < 0xa0 ? CP1252[v - 0x80] : v;
				}
				s = fromCodes(codes);
			} else {
				const hi = this.#encoding === "utf-16be" ? 0 : 1;
				const codes = new Uint16Array(b.length >> 1);
				for (let i = 0; i < codes.length; i++) codes[i] = (b[2 * i + hi] << 8) | b[2 * i + 1 - hi];
				s = fromCodes(codes);
				bad = !s.isWellFormed() || b.length % 2 === 1;
				s = s.toWellFormed();
				if (b.length % 2 === 1) s += "�";
			}

			if (bad && this.#fatal) throw new TypeError(`TextDecoder: the data is not valid ${this.#encoding}`);
			if (!this.#ignoreBOM && this.#encoding !== "windows-1252" && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
			return s;
		}
	};

	globalThis.exit = raw.exit;
	globalThis.args = raw.args;
})();
