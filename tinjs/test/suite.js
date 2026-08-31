// tinjs's own test suite, run by tinjs. args[0] is the fixtures directory.
//
// Two things are being checked here, and the second is the important one. The
// first is that the batteries work: regex, JSON, collections, dates, the things
// a script is actually going to use. The second is that nothing else is there —
// every name that would mean a way out of the interpreter is asserted absent,
// so that a version bump which quietly restores one fails the build.

const fixtures = args[0] || "test/fixtures";

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
	if (cond) {
		passed++;
	} else {
		failures.push(detail ? `${name}: ${detail}` : name);
	}
}

function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	ok(name, a === b, `expected ${b}, got ${a}`);
}

function throws(name, fn) {
	try {
		fn();
		failures.push(`${name}: expected a throw, nothing was thrown`);
	} catch {
		passed++;
	}
}

// ---------------------------------------------------------------- containment

// Every global that would be a way to touch the machine. None of these should
// exist: quickjs-libc is not linked, so there is nothing behind any of them.
const forbidden = [
	"require", "process", "module", "exports", "__dirname", "__filename",
	"std", "os", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun",
	"open", "fopen", "system", "exec", "spawn", "getenv", "setenv",
	"scriptArgs", "loadFile", "writeFile", "readFile", "Worker",
	"setTimeout", "setInterval",
];
for (const name of forbidden) {
	ok(`no global ${name}`, typeof globalThis[name] === "undefined", `${name} is ${typeof globalThis[name]}`);
}

ok("no __tin left on globalThis", typeof globalThis.__tin === "undefined");

// eval and Function exist — they are language, not capability — but there is
// nothing for code they build to reach.
ok("eval is present", typeof eval === "function");
throws("eval cannot conjure require", () => eval("require('fs')"));
throws("Function cannot conjure process", () => new Function("return process.cwd()")());

// import is a syntax error in a script, and there is no loader behind it.
throws("static import is refused", () => eval("import fs from 'fs'"));

// ------------------------------------------------------------------ batteries

// RegExp: the reason this is JavaScript and not Lua.
const m = "2026-08-30T09:14:05Z ERROR connection refused".match(
	/^(?<date>\d{4}-\d{2}-\d{2})T(?<time>[\d:]+)Z\s+(?<level>\w+)\s+(?<msg>.*)$/,
);
eq("regex named groups", m.groups.level, "ERROR");
eq("regex named groups (date)", m.groups.date, "2026-08-30");
eq("regex alternation", "foo|bar".split(/\|/), ["foo", "bar"]);
eq("regex lookbehind", "price: $42".match(/(?<=\$)\d+/)[0], "42");
eq("regex unicode property", "héllo wörld".match(/\p{L}+/gu), ["héllo", "wörld"]);
eq("regex sticky replaceAll", "a-b-c".replaceAll("-", "+"), "a+b+c");
eq("matchAll", [...("a1b2c3".matchAll(/([a-z])(\d)/g))].map((x) => x[2]), ["1", "2", "3"]);

// JSON, both ways.
const people = JSON.parse(read(`${fixtures}/people.json`));
eq("json parse", people.length, 4);
eq("json roundtrip", JSON.parse(JSON.stringify({ a: [1, { b: null }] })), { a: [1, { b: null }] });
eq("json stringify indent", JSON.stringify({ a: 1 }, null, 2), '{\n  "a": 1\n}');

// The actual job: group, aggregate, sort.
const byTeam = {};
for (const p of people) byTeam[p.team] = (byTeam[p.team] || 0) + p.commits;
eq("aggregate", byTeam, { core: 800, infra: 296 });
eq(
	"sort by key",
	people.map((p) => p.name).sort(),
	["ada", "alan", "barbara", "grace"],
);
eq(
	"sort numeric desc",
	[...people].sort((a, b) => b.commits - a.commits)[0].name,
	"ada",
);

// Collections.
const seen = new Map();
for (const line of read(`${fixtures}/log.txt`).trim().split("\n")) {
	const level = line.split(/\s+/)[1];
	seen.set(level, (seen.get(level) || 0) + 1);
}
eq("map counting", [...seen.entries()].sort(), [["ERROR", 2], ["INFO", 2], ["WARN", 1]]);
eq("set dedupe", [...new Set([1, 2, 2, 3, 1])], [1, 2, 3]);

// Strings and numbers.
eq("padStart", "7".padStart(3, "0"), "007");
eq("toFixed", (1 / 3).toFixed(4), "0.3333");
eq("localeCompare-free sort", ["b", "a"].sort().join(""), "ab");
eq("template", `${1 + 1} of ${"three".length}`, "2 of 5");

// Dates.
eq("date parse", new Date("2026-08-30T09:14:05Z").getUTCFullYear(), 2026);
eq("date iso", new Date(Date.UTC(2026, 7, 30)).toISOString(), "2026-08-30T00:00:00.000Z");

// BigInt, typed arrays, base64.
eq("bigint", (2n ** 64n).toString(), "18446744073709551616");
eq("btoa/atob", atob(btoa("hello")), "hello");
const u8 = new Uint8Array([1, 2, 3]);
eq("typed array", Array.from(u8.map((x) => x * 2)), [2, 4, 6]);

// Classes, generators, destructuring, spread — the modern shapes a model writes.
class Counter {
	#n = 0;
	bump() { return ++this.#n; }
}
const c = new Counter();
c.bump();
eq("class private field", c.bump(), 2);
function* gen() { yield 1; yield 2; }
eq("generator", [...gen()], [1, 2]);
const { a: aa, ...restObj } = { a: 1, b: 2, c: 3 };
eq("object rest", [aa, restObj], [1, { b: 2, c: 3 }]);
eq("optional chaining", ({ x: null }).x?.y ?? "dflt", "dflt");

// ------------------------------------------------------------------- tin API

const bytes = readBytes(`${fixtures}/bytes.bin`);
ok("readBytes returns Uint8Array", bytes instanceof Uint8Array);
eq("readBytes length", bytes.length, 10);
eq("readBytes utf8 bytes", Array.from(bytes.slice(0, 5)), [0x63, 0x61, 0x66, 0xc3, 0xa9]);
eq("readBytes handles NUL and 0xff", Array.from(bytes.slice(6)), [0x00, 0x01, 0x02, 0xff]);

eq("read decodes utf8", read(`${fixtures}/bytes.bin`).slice(0, 4), "café");
throws("read of a missing file throws", () => read(`${fixtures}/nope-does-not-exist`));

// lines(): the same reads, one line at a time, for files too big to hold. The
// whole point is that nothing here accumulates, so what is checked is the
// boundaries — terminators, a last line without one, and blank lines in between.
eq("lines counts a file", [...lines(`${fixtures}/log.txt`)].length, 5);
ok("lines strips the terminator", [...lines(`${fixtures}/log.txt`)].every((l) => !l.includes("\n") && !l.endsWith("\r")));
eq("lines matches split, without the trailing empty", [...lines(`${fixtures}/log.txt`)], read(`${fixtures}/log.txt`).split("\n").slice(0, -1));
eq(
	"lines handles CRLF, blanks and a missing final newline",
	[...lines(`${fixtures}/crlf.txt`)],
	["first", "second", "", "fourth"],
);
eq("lines of an empty read is empty", [...lines(`${fixtures}/empty.txt`)], []);
throws("lines of a missing file throws", () => lines(`${fixtures}/nope-does-not-exist`));

// Each call is its own walk: two iterators over one path do not share a position,
// and starting over is just calling lines() again rather than a rewind.
const walkA = lines(`${fixtures}/crlf.txt`);
const walkB = lines(`${fixtures}/crlf.txt`);
eq("independent iterators", [walkA.next().value, walkB.next().value, walkA.next().value], [
	"first",
	"first",
	"second",
]);

// Leaving a for..of early has to close the file, which happens through the
// iterator protocol's return(). It is not observable from in here, but that the
// loop can be left and the path walked again at all is.
let firstOnly = "";
for (const line of lines(`${fixtures}/crlf.txt`)) {
	firstOnly = line;
	break;
}
eq("break leaves the loop", firstOnly, "first");
eq("and the file can be walked again", [...lines(`${fixtures}/crlf.txt`)].length, 4);
ok("lines is iterable more than once per call", typeof lines(`${fixtures}/log.txt`)[Symbol.iterator] === "function");

// readStdin is gone. Under tin stdin is always closed, so it could only ever
// return "" — a binding that cannot work is worse than no binding at all.
ok("no readStdin", typeof globalThis.readStdin === "undefined");

ok("args is an array", Array.isArray(args));

// inspect: quoted inside structures, and cycles do not hang.
eq("inspect object", inspect({ a: 1, b: "x" }), `{ a: 1, b: 'x' }`);
eq("inspect array", inspect([1, "two"]), `[ 1, 'two' ]`);
eq("inspect nested", inspect({ m: new Map([["k", 1]]) }), `{ m: Map(1) { 'k' => 1 } }`);
const cycle = { name: "loop" };
cycle.self = cycle;
ok("inspect handles cycles", inspect(cycle).includes("[Circular]"));

// --------------------------------------------------------------------- async

// Promises resolve because the job queue is drained after the script returns.
// There are no timers, so this is the only kind of asynchrony tinjs has, and
// awaiting the probe rather than racing it is the only way to order the report
// after it.
(async () => {
	const v = await Promise.all([1, Promise.resolve(2)]);
	ok("async/await runs", v[1] === 2);

	let caught = false;
	try {
		await Promise.reject(new Error("nope"));
	} catch (e) {
		caught = e.message === "nope";
	}
	ok("await catches a rejection", caught);

	// ------------------------------------------------------------------- done

	for (const f of failures) console.error(`FAIL ${f}`);
	print(`${passed} passed, ${failures.length} failed`);
	if (failures.length > 0) exit(1);
})();
