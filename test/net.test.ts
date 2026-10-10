import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { DEFAULT_ALLOW_HOSTS, saveHostEntry } from "../src/config.ts";
import {
	type Answer,
	type Ask,
	checkBranch,
	cloneArgs,
	cloneEnv,
	fetchLabel,
	formatFetch,
	type HostList,
	hostListed,
	NetGate,
	parseTarget,
	runClone,
	runFetch,
	suspicions,
	USER_AGENT,
} from "../src/net.ts";
import { checkWritePath } from "../src/policy.ts";
import { resetCaptureSequence, TinDenied } from "../src/run.ts";
import { type Fixture, fixture } from "./helpers.ts";

const posixOnly = { skip: process.platform === "win32" ? "POSIX only" : false };

/** An ask that answers from a script, and remembers what it was asked. */
function scripted(...answers: Answer[]): Ask & { asked: string[] } {
	const asked: string[] = [];
	const ask = async (title: string): Promise<Answer> => {
		asked.push(title);
		const answer = answers.shift();
		assert.ok(answer, `asked more than the script expected: ${title}`);
		return answer;
	};
	return Object.assign(ask, { asked });
}

const chose = (index: number): Answer => ({ kind: "chose", index });
const ONCE = chose(0);
const SESSION = chose(1);
const ALWAYS = chose(2);
const DENY = chose(3);
const ALWAYS_DENY = chose(4);

function gate(fx: Fixture) {
	const saved: Array<[HostList, string]> = [];
	return { gate: new NetGate(fx.policy.net, (list, entry) => saved.push([list, entry])), saved };
}

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	await assert.rejects(promise, (error: Error) => {
		assert.match(error.message, pattern);
		return true;
	});
}

// ---------------------------------------------------------------------------

test("only http and https URLs without credentials are accepted", () => {
	for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "ext::sh -c id", "git@github.com:a/b", "/etc/passwd"]) {
		assert.throws(() => parseTarget(bad), TinDenied, bad);
	}
	assert.throws(() => parseTarget("https://user:pw@example.com/"), /credentials/);
	assert.throws(() => parseTarget("https://token@example.com/"), /credentials/);
});

test("the allowlist key is the host, with a port only off the default", () => {
	assert.equal(parseTarget("https://GitHub.com./a#frag").key, "github.com");
	assert.equal(parseTarget("https://github.com:443/a").key, "github.com");
	assert.equal(parseTarget("http://github.com:8080/a").key, "github.com:8080");
	assert.equal(parseTarget("http://192.168.1.5:8080/").key, "192.168.1.5:8080");
	assert.equal(parseTarget("http://[::1]:3000/").key, "[::1]:3000");
	assert.equal(parseTarget("https://example.com/a#frag").url.href, "https://example.com/a");
});

test("host list entries match exactly, by wildcard, and by port", () => {
	const list = ["github.com", "*.github.io", "localhost:3000", "HTTPS://Docs.RS/", "10.0.0.2"];
	assert.ok(hostListed("10.0.0.2", list), "an IP is a host like any other");
	assert.ok(!hostListed("10.0.0.2:8080", list));
	assert.ok(!hostListed("10.0.0.3", list));
	assert.ok(hostListed("github.com", list));
	assert.ok(hostListed("docs.rs", list));
	assert.ok(hostListed("joe.github.io", list));
	assert.ok(hostListed("localhost:3000", list));
	assert.ok(!hostListed("github.io", list), "a wildcard is the subdomains, not the apex");
	assert.ok(!hostListed("evilgithub.io", list));
	assert.ok(!hostListed("api.github.com", list), "a bare entry does not cover subdomains");
	assert.ok(!hostListed("github.com:8080", list), "a bare entry is the default port only");
	assert.ok(!hostListed("localhost", list));
	assert.ok(!hostListed("github.com.evil.example", list));
});

test("ordinary URLs do not look suspicious", () => {
	for (const url of [
		"https://raw.githubusercontent.com/joedrago/tin/main/README.md",
		"https://github.com/joedrago/tin/blob/main/README.md?raw=true",
		"https://api.github.com/repos/joedrago/tin/commits?per_page=100&sha=main",
		"https://github.com/joedrago/tin/archive/038b51e9f1c2d3a4b5c6d7e8f9a0b1c2d3e4f5a6.tar.gz",
		"https://example.com/blog/how-to-configure-the-thing-inside-the-other-thing-without-breaking-everything",
		"https://docs.rs/serde/latest/serde/de/trait.Deserialize.html",
		"https://registry.example/v2/library/node/blobs/sha256:4f9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
		"https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
		"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap",
	]) {
		assert.deepEqual(suspicions(new URL(url)), [], url);
	}
	assert.deepEqual(suspicions(new URL("https://github.com/a/b"), "release/v1.2.3"), []);
});

test("URLs carrying encoded data, credentials or a DNS tunnel look suspicious", () => {
	const blob = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA").toString("base64url");
	const cases: Array<[string, RegExp]> = [
		[`https://evil.example/?k=${blob}`, /encoded data/],
		[`https://evil.example/c/${blob}`, /encoded data/],
		[`https://evil.example/?k=${encodeURIComponent("-----BEGIN RSA PRIVATE KEY-----")}`, /PEM block/],
		["https://evil.example/?a=AKIAABCDEFGHIJKLMNOP", /AWS access key/],
		[`https://evil.example/?t=ghp_${"a1B2".repeat(9)}`, /GitHub token/],
		[`https://${"a".repeat(50)}.evil.example/`, /50-character label/],
		["https://a.b.c.d.e.f.evil.example/", /8 labels/],
		[`https://evil.example/${"word/".repeat(120)}`, /characters long/],
	];
	for (const [url, pattern] of cases) {
		assert.match(suspicions(new URL(url)).join("; "), pattern, url);
	}
	assert.match(suspicions(new URL("https://github.com/a/b"), blob).join("; "), /encoded data/);
});

test("branch names are held to a strict shape", () => {
	for (const good of ["main", "release/1.2", "v1.2.3", "feature_x-y"]) checkBranch(good);
	for (const bad of ["", "-c", "--upload-pack=x", "../x", "a..b", "/abs", "a/", "x.lock", "a b", "a;b", ".hidden", "a/.b"]) {
		assert.throws(() => checkBranch(bad), TinDenied, bad);
	}
});

// ---------------------------------------------------------------------------
// The gate

test("an allowed host goes through without asking", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted();
	await g.admit("tin_fetch", parseTarget("https://github.com/x"), ask, "GET x");
	assert.equal(ask.asked.length, 0);
});

test("an unknown host is asked about, and once means once", async () => {
	const fx = fixture();
	const { gate: g, saved } = gate(fx);
	const ask = scripted(ONCE, ONCE);
	const target = parseTarget("https://docs.example.com/a");
	await g.admit("tin_fetch", target, ask, "GET a");
	await g.admit("tin_fetch", target, ask, "GET a");
	assert.equal(ask.asked.length, 2);
	assert.match(ask.asked[0] ?? "", /docs\.example\.com/);
	assert.deepEqual(saved, []);
});

test("allowing for the session stops the asking without saving anything", async () => {
	const fx = fixture();
	const { gate: g, saved } = gate(fx);
	const ask = scripted(SESSION);
	const target = parseTarget("https://docs.example.com/a");
	await g.admit("tin_fetch", target, ask, "GET a");
	await g.admit("tin_fetch", parseTarget("https://docs.example.com/b"), ask, "GET b");
	assert.equal(ask.asked.length, 1);
	assert.deepEqual(saved, []);
	assert.deepEqual(g.sessionAllowed, ["docs.example.com"]);
});

test("always allow hands the host to persist, and stops the asking", async () => {
	const fx = fixture();
	const { gate: g, saved } = gate(fx);
	const ask = scripted(ALWAYS);
	await g.admit("tin_fetch", parseTarget("http://localhost:3000/"), ask, "GET /");
	await g.admit("tin_fetch", parseTarget("http://localhost:3000/again"), ask, "GET /again");
	assert.equal(ask.asked.length, 1);
	assert.deepEqual(saved, [["allowHosts", "localhost:3000"]]);
});

test("an IP address is asked about like any unknown host", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted(DENY);
	await rejectsWith(g.admit("tin_fetch", parseTarget("http://169.254.169.254/latest/meta-data/"), ask, "GET /"), /declined/);
	assert.match(ask.asked[0] ?? "", /not on your allowed list: 169\.254\.169\.254/);
});

test("always deny hands the host to persist, and refuses it from then on without asking", async () => {
	const fx = fixture();
	const { gate: g, saved } = gate(fx);
	const ask = scripted(ALWAYS_DENY);
	const target = parseTarget("https://evil.example/");
	await rejectsWith(g.admit("tin_fetch", target, ask, "GET /"), /user declined/);
	await rejectsWith(g.admit("tin_fetch", target, ask, "GET /"), /already declined/);
	assert.equal(ask.asked.length, 1);
	assert.deepEqual(saved, [["denyHosts", "evil.example"]]);
});

test("denyHosts refuses without asking, and wins over allowHosts", async () => {
	const fx = fixture({ net: { allowHosts: ["github.com", "*.evil.example"], denyHosts: ["github.com", "*.evil.example"] } });
	const { gate: g } = gate(fx);
	const ask = scripted();
	await rejectsWith(g.admit("tin_fetch", parseTarget("https://github.com/"), ask, "GET /"), /net\.denyHosts/);
	await rejectsWith(g.admit("tin_fetch", parseTarget("https://a.evil.example/"), ask, "GET /"), /net\.denyHosts/);
	assert.equal(ask.asked.length, 0);
});

test("a malformed denyHosts turns the network off rather than reaching what it meant to refuse", () => {
	const fx = fixture({ net: { denyHosts: "evil.example" } });
	assert.equal(fx.policy.net.enabled, false);
	assert.ok(fx.policy.warnings.some((warning) => /denyHosts/.test(warning)));
});

test("the options never lead with always allow", async () => {
	const fx = fixture();
	const options: string[][] = [];
	const ask: Ask = async (_title, offered) => {
		options.push(offered);
		return ONCE;
	};
	await new NetGate(fx.policy.net, () => {}).admit(
		"tin_fetch",
		parseTarget("https://docs.example.com/"),
		ask,
		"GET /",
	);
	assert.equal(options[0]?.[0], "Allow once");
	assert.match(options[0]?.[2] ?? "", /^Always allow/);
	assert.match(options[0]?.[4] ?? "", /^Always deny/);
});

test("a no stands for the session, without asking again", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted(DENY);
	const target = parseTarget("https://evil.example/");
	await rejectsWith(g.admit("tin_fetch", target, ask, "GET /"), /user declined.*do not retry/s);
	await rejectsWith(g.admit("tin_fetch", target, ask, "GET /"), /already declined/);
	assert.equal(ask.asked.length, 1);
});

test("closing the question counts as a no", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted({ kind: "dismissed" });
	await rejectsWith(g.admit("tin_fetch", parseTarget("https://evil.example/"), ask, "GET /"), /user declined/);
});

test("a timeout is not a refusal, says so, and is asked again next time", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted({ kind: "timeout" }, ONCE);
	const target = parseTarget("https://docs.example.com/");
	await rejectsWith(
		g.admit("tin_fetch", target, ask, "GET /"),
		/nobody answered within 60s.*not a refusal.*stepped away.*waiting on their approval/s,
	);
	await g.admit("tin_fetch", target, ask, "GET /");
	assert.equal(ask.asked.length, 2);
});

test("with no UI to ask in, an unknown host is not reached", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	await rejectsWith(
		g.admit("tin_fetch", parseTarget("https://docs.example.com/"), scripted({ kind: "unavailable" }), "GET /"),
		/no interactive UI.*net\.allowHosts/s,
	);
});

test("a suspicious URL is asked about even on an allowed host", async () => {
	const fx = fixture();
	const { gate: g } = gate(fx);
	const ask = scripted(DENY);
	const target = parseTarget(`https://github.com/?k=${"QUJD".repeat(20)}`);
	await rejectsWith(g.admit("tin_fetch", target, ask, `GET ${target.url.href}`), /declined/);
	assert.match(ask.asked[0] ?? "", /carrying data out.*encoded data/s);
	assert.deepEqual(ask.asked.length, 1);
});

// ---------------------------------------------------------------------------
// Fetching, against a server on this machine

interface Seen {
	url: string;
	headers: IncomingHttpHeaders;
}

async function serve(handler: http.RequestListener): Promise<{ port: number; seen: Seen[]; close: () => void }> {
	const seen: Seen[] = [];
	const server = http.createServer((request, response) => {
		seen.push({ url: request.url ?? "", headers: request.headers });
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
}

function permissive(fx: Fixture) {
	return new NetGate(fx.policy.net, () => {});
}
const yes: Ask = async () => ONCE;

test("a fetch lands in the capture directory, with nothing but a user agent", async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await serve((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/markdown" });
		response.end("# hello\n");
	});
	try {
		const result = await runFetch(
			permissive(fx),
			fx.policy,
			`http://localhost:${server.port}/guide/README.md?raw=true`,
			yes,
		);
		assert.equal(result.path, path.join(fx.captureDir, "1-fetch-README.md"));
		assert.equal(readFileSync(result.path, "utf8"), "# hello\n");
		assert.equal(result.status, 200);
		assert.equal(server.seen[0]?.url, "/guide/README.md?raw=true", "the query string is sent as written");

		const headers = server.seen[0]?.headers ?? {};
		assert.deepEqual(Object.keys(headers).sort(), ["accept", "connection", "host", "user-agent"]);
		assert.equal(headers["user-agent"], USER_AGENT);
		assert.equal(headers.accept, "*/*");

		const text = formatFetch(result);
		assert.match(text, /^\/.*1-fetch-README\.md\nHTTP 200 OK, text\/markdown, 8 B$/);
	} finally {
		server.close();
	}
});

test("a redirect is followed, and the new host goes back through the gate", async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await serve((request, response) => {
		if (request.url === "/old") {
			response.writeHead(302, { Location: `http://127.0.0.1:${request.socket.localPort ?? 0}/new` });
			response.end();
		} else {
			response.end("moved here");
		}
	});
	try {
		const asked: string[] = [];
		const ask: Ask = async (title) => {
			asked.push(title);
			return ONCE;
		};
		const result = await runFetch(permissive(fx), fx.policy, `http://localhost:${server.port}/old`, ask);
		assert.equal(readFileSync(result.path, "utf8"), "moved here");
		assert.equal(result.redirects, 1);
		assert.equal(result.finalUrl, `http://127.0.0.1:${server.port}/new`);
		assert.match(formatFetch(result), /final URL after 1 redirect: http:\/\/127\.0\.0\.1/);
		assert.equal(asked.length, 2);
		assert.ok(asked[1]?.includes(`127.0.0.1:${server.port}`), "the redirect's host was asked about");
	} finally {
		server.close();
	}
});

test("a redirect back to a host allowed once is not asked about again", async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await serve((request, response) => {
		if (request.url === "/old") {
			response.writeHead(301, { Location: "/new" });
			response.end();
		} else {
			response.end("same host");
		}
	});
	try {
		const ask = scripted(ONCE);
		await runFetch(permissive(fx), fx.policy, `http://localhost:${server.port}/old`, ask);
		assert.equal(ask.asked.length, 1);
	} finally {
		server.close();
	}
});

test("an error status saves nothing", async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await serve((_request, response) => {
		response.writeHead(404);
		response.end("not here");
	});
	try {
		await rejectsWith(
			runFetch(permissive(fx), fx.policy, `http://localhost:${server.port}/missing`, yes),
			/HTTP 404 Not Found; nothing was saved/,
		);
		assert.deepEqual(readdirSync(fx.captureDir), []);
	} finally {
		server.close();
	}
});

test("a response over maxFetchBytes is refused and leaves no file", async () => {
	const fx = fixture({ net: { maxFetchBytes: 1024 } });
	resetCaptureSequence();
	const server = await serve((_request, response) => response.end("x".repeat(5000)));
	try {
		await rejectsWith(
			runFetch(permissive(fx), fx.policy, `http://localhost:${server.port}/big`, yes),
			/larger than net\.maxFetchBytes/,
		);
		assert.deepEqual(readdirSync(fx.captureDir), []);
	} finally {
		server.close();
	}
});

test("a body the server compressed anyway is saved decoded", async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await serve((_request, response) => {
		response.writeHead(200, { "Content-Encoding": "gzip" });
		response.end(gzipSync("plain text\n"));
	});
	try {
		const result = await runFetch(permissive(fx), fx.policy, `http://localhost:${server.port}/`, yes);
		assert.equal(readFileSync(result.path, "utf8"), "plain text\n");
		assert.equal(path.basename(result.path), "1-fetch.out");
	} finally {
		server.close();
	}
});

test("capture names are sanitized to a bare file name", () => {
	assert.equal(fetchLabel(new URL("https://x.example/a/..%2F..%2Fetc%2Fpasswd")), "fetch-etcpasswd");
	assert.equal(fetchLabel(new URL("https://x.example/")), "fetch.out");
	assert.equal(fetchLabel(new URL("https://x.example/.bashrc")), "fetch-bashrc");
});

// ---------------------------------------------------------------------------
// Saving "always allow"

test("always allow writes the list in force plus the new host into a new tin.json", () => {
	const fx = fixture();
	const configPath = path.join(fx.agentDir, "tin.json");
	saveHostEntry(configPath, "allowHosts", "docs.example.com", [...DEFAULT_ALLOW_HOSTS]);
	const written = JSON.parse(readFileSync(configPath, "utf8"));
	assert.deepEqual(written.net.allowHosts, [...DEFAULT_ALLOW_HOSTS, "docs.example.com"]);
});

test("always allow keeps the rest of tin.json and its indentation", () => {
	const fx = fixture();
	const configPath = path.join(fx.agentDir, "tin.json");
	writeFileSync(configPath, '{\n\t"binDir": "~/bin2",\n\t"net": { "askTimeoutMs": 5000, "allowHosts": ["a.example"] }\n}\n');
	saveHostEntry(configPath, "allowHosts", "b.example", ["ignored"]);
	saveHostEntry(configPath, "allowHosts", "b.example", ["ignored"]);
	saveHostEntry(configPath, "denyHosts", "evil.example", []);
	const raw = readFileSync(configPath, "utf8");
	assert.match(raw, /^\t"binDir"/m);
	const written = JSON.parse(raw);
	assert.equal(written.binDir, "~/bin2");
	assert.equal(written.net.askTimeoutMs, 5000);
	assert.deepEqual(written.net.allowHosts, ["a.example", "b.example"]);
	assert.deepEqual(written.net.denyHosts, ["evil.example"]);
});

test("always allow writes through a symlinked tin.json rather than replacing it", posixOnly, () => {
	const fx = fixture();
	const real = path.join(fx.root, "dotfiles", "tin.json");
	mkdirSync(path.dirname(real), { recursive: true });
	writeFileSync(real, "{}");
	const configPath = path.join(fx.agentDir, "tin.json");
	symlinkSync(real, configPath);
	saveHostEntry(configPath, "allowHosts", "docs.example.com", []);
	assert.ok(lstatSync(configPath).isSymbolicLink());
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).net.allowHosts, ["docs.example.com"]);
});

test("always allow refuses to rewrite a tin.json it cannot parse", () => {
	const fx = fixture();
	const configPath = path.join(fx.agentDir, "tin.json");
	writeFileSync(configPath, "{ not json");
	assert.throws(() => saveHostEntry(configPath, "denyHosts", "x.example", []));
	assert.equal(readFileSync(configPath, "utf8"), "{ not json");
});

// ---------------------------------------------------------------------------
// Cloning

test("the clone command line is fixed", () => {
	const target = parseTarget("https://github.com/a/b.git");
	const args = cloneArgs(target, "/tmp/x", "main");
	assert.deepEqual(args.slice(-3), ["--", "https://github.com/a/b.git", "/tmp/x"]);
	for (const expected of [
		"protocol.allow=never",
		"protocol.https.allow=always",
		"http.followRedirects=false",
		"--config=core.symlinks=false",
		"--depth=1",
		"--branch=main",
	]) {
		assert.ok(args.includes(expected), expected);
	}
	assert.ok(!args.some((arg) => arg.includes("recurse-submodules")));
});

test("the clone environment has none of your git configuration or credentials", () => {
	const env = cloneEnv("/nowhere", {
		PATH: "/usr/bin",
		HOME: "/home/you",
		GIT_SSH_COMMAND: "evil",
		GIT_CONFIG_COUNT: "1",
		git_exec_path: "/x",
		SSH_AUTH_SOCK: "/tmp/agent",
		SSH_ASKPASS: "/bin/ask",
		https_proxy: "http://proxy",
		NETRC: "/home/you/.netrc",
	});
	assert.deepEqual(env, {
		PATH: "/usr/bin",
		HOME: "/nowhere",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	});
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
}

/** A smart-HTTP git server: `git http-backend` behind a small CGI shim. */
async function gitServer(projectRoot: string) {
	return serve((request, response) => {
		const url = new URL(request.url ?? "/", "http://x");
		const header = (name: string) => String(request.headers[name] ?? "");
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: "1",
				REQUEST_METHOD: request.method ?? "GET",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: header("content-type"),
				HTTP_CONTENT_ENCODING: header("content-encoding"),
				GIT_PROTOCOL: header("git-protocol"),
			},
		});
		request.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("close", () => {
			const output = Buffer.concat(chunks);
			const split = output.indexOf("\r\n\r\n");
			const head = output.subarray(0, split).toString("utf8");
			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of head.split("\r\n")) {
				const [name = "", ...rest] = line.split(": ");
				if (name.toLowerCase() === "status") status = Number.parseInt(rest.join(": "), 10);
				else if (name !== "") headers[name] = rest.join(": ");
			}
			response.writeHead(status, headers);
			response.end(output.subarray(split + 4));
		});
	});
}

function seedRepository(fx: Fixture): string {
	const source = path.join(fx.root, "source");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(path.join(source, "README.md"), "main branch\n");
	symlinkSync("/etc/passwd", path.join(source, "link"));
	git(source, "add", ".");
	git(source, "commit", "-qm", "first");
	writeFileSync(path.join(source, "README.md"), "main branch, second\n");
	git(source, "commit", "-qam", "second");
	git(source, "checkout", "-qb", "feature");
	writeFileSync(path.join(source, "FEATURE.md"), "feature\n");
	git(source, "add", ".");
	git(source, "commit", "-qm", "feature");

	const projectRoot = path.join(fx.root, "served");
	mkdirSync(projectRoot);
	git(fx.root, "clone", "-q", "--bare", source, path.join(projectRoot, "repo.git"));
	return projectRoot;
}

test("a clone is shallow, anonymous, and checks symlinks out inert", posixOnly, async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await gitServer(seedRepository(fx));
	try {
		const dir = await runClone(permissive(fx), fx.policy, `http://localhost:${server.port}/repo.git`, undefined, yes);
		assert.equal(dir, path.join(fx.captureDir, "1-clone-repo"));
		assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "main branch, second\n");
		assert.ok(existsSync(path.join(dir, ".git", "shallow")), "depth 1");
		assert.ok(!lstatSync(path.join(dir, "link")).isSymbolicLink(), "core.symlinks=false");

		// The read-only git wrapper reaches the clone with -C, from a cwd elsewhere, and
		// finds a clean working tree: the symlink setting was kept in the clone's config.
		const wrapper = path.join(import.meta.dirname, "..", "wrappers", "git");
		const run = (...args: string[]) => execFileSync(wrapper, ["-C", dir, ...args], { cwd: fx.workspace, encoding: "utf8" });
		assert.equal(run("status", "--porcelain"), "");
		assert.equal(run("log", "--oneline").trim().split("\n").length, 1);

		const feature = await runClone(
			permissive(fx),
			fx.policy,
			`http://localhost:${server.port}/repo.git`,
			"feature",
			yes,
		);
		assert.equal(readFileSync(path.join(feature, "FEATURE.md"), "utf8"), "feature\n");
	} finally {
		server.close();
	}
});

test("a clone that fails says why and leaves nothing behind", posixOnly, async () => {
	const fx = fixture();
	resetCaptureSequence();
	const server = await gitServer(seedRepository(fx));
	try {
		await rejectsWith(
			runClone(permissive(fx), fx.policy, `http://localhost:${server.port}/missing.git`, undefined, yes),
			/git clone .* failed/,
		);
		assert.deepEqual(readdirSync(fx.captureDir), []);
	} finally {
		server.close();
	}
});

test("what tin_fetch and tin_clone leave is never writable, whatever the write roots say", () => {
	const fx = fixture();
	const broad = fixture({ writeRoots: [fx.root] });
	for (const entry of ["1-fetch-README.md", path.join("2-clone-repo", "README.md")]) {
		const decision = checkWritePath(path.join(broad.policy.captureDir, entry), broad.policy, broad.workspace);
		assert.equal(decision.allow, false, entry);
	}
});
