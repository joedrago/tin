import { createWriteStream, rmSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import type { TinNetPolicy, TinPolicy } from "./config.ts";
import {
	describeBytes,
	execCommand,
	nextCaptureEntry,
	type ExecOutcome,
	type ResolvedCommand,
	TinDenied,
} from "./run.ts";

export const TIN_FETCH = "tin_fetch";
export const TIN_CLONE = "tin_clone";

/**
 * The one header a fetch carries beyond what HTTP itself requires. A browser's,
 * because plenty of sites answer an unknown client with a block page instead of
 * the document; the version only has to be plausible, not current.
 */
export const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Where a request is going

export interface NetTarget {
	url: URL;
	/**
	 * Who the request is going to, as the host lists see it: the host, plus `:port`
	 * when it is not the scheme's default. An IP address is a host like any other,
	 * so 192.168.1.5:8080 is asked about, allowed and denied the same way a name is.
	 */
	key: string;
}

/**
 * Parse and check a URL the model gave, or one a redirect pointed at.
 *
 * Only http and https, and never with credentials in it: tin sends no credentials
 * of any kind, and a user:password@ in the URL is one Node would quietly turn into
 * an Authorization header. The fragment is dropped, since it is never sent anyway.
 */
export function parseTarget(input: string): NetTarget {
	let url: URL;
	try {
		url = new URL(String(input).trim());
	} catch {
		throw new TinDenied(`tin: "${input}" is not a valid absolute URL.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TinDenied(`tin: only http and https URLs are allowed, not ${url.protocol}`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new TinDenied(
			"tin: URLs with a user name or password in them are refused — tin sends no credentials of any kind.",
		);
	}
	url.hash = "";

	const host = url.hostname.replace(/\.$/, "");
	return { url, key: url.port === "" ? host : `${host}:${url.port}` };
}

function splitKey(key: string): { host: string; port: string } {
	const match = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(key);
	return { host: match?.[1] ?? key, port: match?.[2] ?? "" };
}

/** Forgive an entry written as a URL, in any case, or with a trailing dot. */
export function normalizeHostEntry(entry: string): string {
	return entry
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/\.(:|$)/, "$1");
}

/**
 * Whether a host list (allowHosts or denyHosts) names a host.
 *
 * `example.com` is that host and nothing under it; `*.example.com` is everything
 * under it and not the apex. The port has to match too, and an entry without one
 * means the scheme's default — so allowing github.com does not allow whatever might
 * be listening on github.com:8080.
 */
export function hostListed(key: string, entries: string[]): boolean {
	const want = splitKey(key);
	return entries.some((raw) => {
		const entry = splitKey(normalizeHostEntry(raw));
		if (entry.port !== want.port) return false;
		if (entry.host.startsWith("*.")) return want.host.endsWith(entry.host.slice(1));
		return entry.host === want.host;
	});
}

// ---------------------------------------------------------------------------
// What a request looks like it is carrying

// Runs of characters that encoded data is made of. "/" and "." are left out on
// purpose: they are what separates the words of an ordinary path.
const ENCODED_RUN = /[A-Za-z0-9+=%_-]{48,}/g;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
	[/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/, "a PEM block"],
	[/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
	[/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
	[/\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
	[/\bsk-[A-Za-z0-9_-]{20,}/, "a secret API key"],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/, "a JWT"],
];

/**
 * A long run that reads like data rather than words. A slug is long too, but it is
 * short words joined by hyphens; base64 and hex are long stretches with nothing in
 * between. A bare commit id or sha256 digest is the one long run with a good reason
 * to be in a URL, so those pass.
 */
function looksEncoded(run: string): boolean {
	if (HASH.test(run)) return false;
	const words = run.split(/[-_]+/).filter((word) => word !== "");
	return run.length / Math.max(words.length, 1) >= 12;
}

function abbreviate(text: string): string {
	return text.length <= 24 ? text : `${text.slice(0, 12)}…${text.slice(-8)}`;
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * Reasons a request looks like it might be carrying data out, or none.
 *
 * This is a speed bump, not a wall. It catches the careless shape — a key pasted
 * into a query string, a blob of base64 in the path, a hostname used as a DNS
 * tunnel — and anything patient enough to send a secret forty characters at a time
 * gets past it. What it buys is that the careless shape, which is the one a
 * prompt-injected model actually produces, is put in front of a person first.
 *
 * Only for what the model wrote. A redirect is the server's choice, and by the time
 * it is made the server already has whatever the first request carried.
 */
export function suspicions(url: URL, branch?: string): string[] {
	const reasons: string[] = [];

	const host = url.hostname;
	if (!/^[\d.]+$|^\[/.test(host)) {
		const labels = host.split(".");
		const longest = Math.max(...labels.map((label) => label.length));
		if (longest > 40) reasons.push(`its hostname has a ${longest}-character label`);
		if (labels.length > 6) reasons.push(`its hostname has ${labels.length} labels`);
	}

	const rest = url.pathname + url.search;
	if (rest.length > 512) reasons.push(`its path and query are ${rest.length} characters long`);
	if (branch !== undefined && branch.length > 100) {
		reasons.push(`the branch name is ${branch.length} characters long`);
	}

	for (const text of branch === undefined ? [rest] : [rest, branch]) {
		const run = (text.match(ENCODED_RUN) ?? []).find(looksEncoded);
		if (run) {
			reasons.push(
				`it contains a ${run.length}-character run that looks like encoded data (${abbreviate(run)})`,
			);
		}
	}

	const decoded = `${safeDecode(url.href)} ${branch ?? ""}`;
	for (const [shape, name] of CREDENTIAL_SHAPES) {
		const reason = `it contains something shaped like ${name}`;
		if (shape.test(decoded) && !reasons.includes(reason)) reasons.push(reason);
	}

	return reasons;
}

// ---------------------------------------------------------------------------
// Asking

/** How a question put to the user came out. */
export type Answer =
	| { kind: "chose"; index: number }
	/** The user closed it without choosing — as good as "no". */
	| { kind: "dismissed" }
	/** Nobody answered in time, which is not the same as "no". */
	| { kind: "timeout" }
	/** There is no one to ask: pi is running without a UI. */
	| { kind: "unavailable" }
	/** The turn was cancelled while the question was open. */
	| { kind: "aborted" };

export type Ask = (title: string, options: string[]) => Promise<Answer>;

/** Which tin.json list an "Always" answer goes into. */
export type HostList = "allowHosts" | "denyHosts";

/**
 * The approvals one session has given and refused.
 *
 * The kinds of answer are kept apart on purpose. "Always" goes through `persist`,
 * which writes tin.json, and so outlives the session. A plain "no" stands for the
 * rest of the session, so the user is not asked the same thing twice. A timeout
 * stands for nothing, because it means nobody was there, and the model is told that
 * in so many words so it can say what is waiting rather than conclude it was
 * refused.
 */
export class NetGate {
	/** What this session fetched and cloned, for /tin. */
	readonly history: string[] = [];

	private readonly sessionHosts = new Set<string>();
	private readonly deniedHosts = new Set<string>();
	private readonly deniedRequests = new Set<string>();
	private readonly policy: TinNetPolicy;
	private readonly persist: (list: HostList, entry: string) => void;

	constructor(policy: TinNetPolicy, persist: (list: HostList, entry: string) => void) {
		this.policy = policy;
		this.persist = persist;
	}

	/** Hosts allowed for this session only, for /tin. */
	get sessionAllowed(): string[] {
		return [...this.sessionHosts];
	}

	/**
	 * Both checks on the request as the model wrote it: where it goes, then what it
	 * says. Nothing is resolved or sent until both have passed — resolving a name is
	 * itself a message to whoever runs its nameserver. The set that comes back holds
	 * the hosts allowed just this once, so a redirect back to one of them is not
	 * asked about twice.
	 */
	async admit(tool: string, target: NetTarget, ask: Ask, request: string, branch?: string): Promise<Set<string>> {
		const once = new Set<string>();
		await this.admitHost(tool, target, ask, request, once);
		await this.admitContent(tool, target, ask, request, branch);
		return once;
	}

	/**
	 * Whether a host may be reached, asking when neither list says. denyHosts is
	 * checked first, so a host on both lists is denied.
	 */
	async admitHost(tool: string, target: NetTarget, ask: Ask, request: string, once: Set<string>): Promise<void> {
		const what = `${tool} reaching ${target.key}`;
		if (hostListed(target.key, this.policy.denyHosts)) throw blocked(what);
		if (once.has(target.key) || this.sessionHosts.has(target.key)) return;
		if (hostListed(target.key, this.policy.allowHosts)) return;
		if (this.deniedHosts.has(target.key)) throw declinedEarlier(what);

		const answer = await ask(
			`${tool} wants to reach a host that is not on your allowed list: ${target.key}\n\n  ${request}`,
			[
				"Allow once",
				`Allow ${target.key} for this session`,
				`Always allow ${target.key} (adds it to tin.json)`,
				"Deny",
				`Always deny ${target.key} (adds it to tin.json)`,
			],
		);
		switch (this.settle(answer, what)) {
			case 0:
				once.add(target.key);
				return;
			case 1:
				this.sessionHosts.add(target.key);
				return;
			case 2:
				this.sessionHosts.add(target.key);
				this.persist("allowHosts", target.key);
				return;
			case 4:
				this.deniedHosts.add(target.key);
				this.persist("denyHosts", target.key);
				throw declined(what);
			default:
				this.deniedHosts.add(target.key);
				throw declined(what);
		}
	}

	async admitContent(tool: string, target: NetTarget, ask: Ask, request: string, branch?: string): Promise<void> {
		const reasons = suspicions(target.url, branch);
		if (reasons.length === 0) return;
		const what = `this ${tool} request`;
		if (this.deniedRequests.has(request)) throw declinedEarlier(what);

		const answer = await ask(
			`${tool}: this request looks like it could be carrying data out —\n${reasons.map((reason) => `  - ${reason}`).join("\n")}\n\n  ${request}`,
			["Allow once", "Deny"],
		);
		if (this.settle(answer, what) !== 0) {
			this.deniedRequests.add(request);
			throw declined(what);
		}
	}

	/**
	 * The index the user chose, or -1 for an explicit "no". Anything that is not an
	 * answer at all throws here, with a message that says which kind of not-an-answer
	 * it was, and leaves no trace in the session's refusals.
	 */
	private settle(answer: Answer, what: string): number {
		switch (answer.kind) {
			case "chose":
				return answer.index;
			case "dismissed":
				return -1;
			case "timeout":
				throw new TinDenied(
					`tin: ${what} needs the user's approval, and nobody answered within ` +
						`${Math.round(this.policy.askTimeoutMs / 1000)}s, so it did not happen. This is not a ` +
						`refusal — the user has most likely stepped away. Do not retry it now: carry on with ` +
						`whatever does not depend on it, and when you finish, say that this request is waiting ` +
						`on their approval.`,
				);
			case "unavailable":
				throw new TinDenied(
					`tin: ${what} needs the user's approval, and this session has no interactive UI to ask ` +
						`in, so it did not happen. Hosts listed in net.allowHosts in tin.json are reached ` +
						`without asking.`,
				);
			case "aborted":
				throw new TinDenied(`tin: ${what} was cancelled.`);
		}
	}
}

function declined(what: string): TinDenied {
	return new TinDenied(
		`tin: the user declined ${what}. That is their decision for the rest of this session: do not ` +
			`retry it, and do not try to reach the same thing another way.`,
	);
}

function declinedEarlier(what: string): TinDenied {
	return new TinDenied(
		`tin: the user already declined ${what} earlier in this session. Do not retry it, and do not ` +
			`try to reach the same thing another way.`,
	);
}

function blocked(what: string): TinDenied {
	return new TinDenied(
		`tin: ${what} is denied — the host is on the user's net.denyHosts list. Do not retry it, and do ` +
			`not try to reach the same thing another way.`,
	);
}

// ---------------------------------------------------------------------------
// Fetching

/** A capture-directory name that hints at what is in it, sanitized to a bare file name. */
function entryLabel(prefix: string, name: string | undefined): string {
	const clean = (name ?? "")
		.replace(/[^A-Za-z0-9._-]/g, "")
		.replace(/^[.-]+/, "")
		.slice(0, 60);
	return clean === "" ? prefix : `${prefix}-${clean}`;
}

function lastSegment(url: URL): string | undefined {
	const last = url.pathname.split("/").filter((segment) => segment !== "").pop();
	return last === undefined ? undefined : safeDecode(last);
}

export function fetchLabel(url: URL): string {
	const label = entryLabel("fetch", lastSegment(url));
	return label === "fetch" ? "fetch.out" : label;
}

export function cloneLabel(url: URL): string {
	return entryLabel("clone", lastSegment(url)?.replace(/\.git$/i, ""));
}

/**
 * One GET. The headers are the user agent and `Accept: *\/*`, which says nothing,
 * and nothing else: no cookies, no Authorization, no Referer, no Accept-Encoding
 * (so servers send the body plain, though one that compresses anyway is decoded).
 * `agent: false` keeps every request on a connection of its own, so nothing about
 * one request carries over into another.
 */
function get(target: NetTarget, signal: AbortSignal): Promise<IncomingMessage> {
	const options = {
		method: "GET",
		headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
		agent: false as const,
		signal,
	};
	return new Promise((resolve, reject) => {
		const request =
			target.url.protocol === "https:"
				? https.request(target.url, options, resolve)
				: http.request(target.url, options, resolve);
		request.on("error", reject);
		request.end();
	});
}

function decoderFor(encoding: string | undefined): Transform | undefined {
	switch (encoding?.trim().toLowerCase()) {
		case "gzip":
		case "x-gzip":
			return zlib.createGunzip();
		case "deflate":
			return zlib.createInflate();
		case "br":
			return zlib.createBrotliDecompress();
		default:
			return undefined;
	}
}

async function save(
	response: IncomingMessage,
	dest: string,
	limit: number,
	signal: AbortSignal,
): Promise<number> {
	let bytes = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			if (bytes > limit) {
				done(new Error(`tin: the response is larger than net.maxFetchBytes (${describeBytes(limit)}); nothing was saved`));
			} else {
				done(null, chunk);
			}
		},
	});
	const decoder = decoderFor(response.headers["content-encoding"]);
	const stages = decoder ? [response, decoder, meter] : [response, meter];
	try {
		await pipeline([...stages, createWriteStream(dest, { flags: "wx", mode: 0o600 })], { signal });
	} catch (error) {
		// A file that is not all there is never handed out, so it does not stay.
		// "wx" means an EEXIST was somebody else's file, and that one does.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") rmSync(dest, { force: true });
		throw error;
	}
	return bytes;
}

export interface FetchResult {
	path: string;
	status: number;
	statusText: string;
	contentType: string | undefined;
	bytes: number;
	finalUrl: string;
	redirects: number;
}

/**
 * GET a URL into `dest`, following redirects.
 *
 * `hop` approves each step before anything is sent. Redirects are followed here
 * rather than by anything below, so every one of them goes back through it.
 */
export async function fetchToFile(
	start: NetTarget,
	dest: string,
	options: {
		net: TinNetPolicy;
		signal?: AbortSignal;
		hop: (target: NetTarget, redirected: boolean) => Promise<void>;
	},
): Promise<FetchResult> {
	let target = start;
	for (let redirects = 0; ; redirects++) {
		await options.hop(target, redirects > 0);

		// A fresh deadline for each step, so time spent waiting on a question is not
		// taken out of the time the transfer has.
		const deadline = AbortSignal.timeout(options.net.timeoutMs);
		const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
		const failed = (error: unknown): Error => {
			if (deadline.aborted) {
				return new Error(`tin: ${target.url.href} timed out after ${Math.round(options.net.timeoutMs / 1000)}s`);
			}
			if (options.signal?.aborted) return new Error(`tin: fetching ${target.url.href} was cancelled`);
			const message = (error as Error).message;
			return new Error(message.startsWith("tin:") ? message : `tin: fetching ${target.url.href} failed: ${message}`);
		};

		let response: IncomingMessage;
		try {
			response = await get(target, signal);
		} catch (error) {
			throw failed(error);
		}

		const status = response.statusCode ?? 0;
		const location = response.headers.location;
		if (REDIRECTS.has(status) && location) {
			response.resume();
			if (redirects >= MAX_REDIRECTS) {
				throw new Error(`tin: ${start.url.href} redirected more than ${MAX_REDIRECTS} times`);
			}
			target = parseTarget(new URL(location, target.url).href);
			continue;
		}
		if (status < 200 || status >= 300) {
			response.resume();
			const text = response.statusMessage ? ` ${response.statusMessage}` : "";
			throw new Error(`tin: ${target.url.href} answered HTTP ${status}${text}; nothing was saved`);
		}

		let bytes: number;
		try {
			bytes = await save(response, dest, options.net.maxFetchBytes, signal);
		} catch (error) {
			throw failed(error);
		}
		return {
			path: dest,
			status,
			statusText: response.statusMessage ?? "",
			contentType: response.headers["content-type"],
			bytes,
			finalUrl: target.url.href,
			redirects,
		};
	}
}

/** What the model is told about a fetch that worked: where, and one line about what. */
export function formatFetch(result: FetchResult): string {
	const facts = [
		`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`,
		result.contentType ?? "no content type",
		describeBytes(result.bytes),
	];
	const lines = [result.path, facts.join(", ")];
	if (result.redirects > 0) {
		lines.push(`final URL after ${result.redirects} redirect${result.redirects === 1 ? "" : "s"}: ${result.finalUrl}`);
	}
	return lines.join("\n");
}

/** The whole of tin_fetch, minus the pi wiring. */
export async function runFetch(
	gate: NetGate,
	policy: TinPolicy,
	input: string,
	ask: Ask,
	signal?: AbortSignal,
): Promise<FetchResult> {
	const target = parseTarget(input);
	const request = `GET ${target.url.href}`;
	const once = await gate.admit(TIN_FETCH, target, ask, request);

	const result = await fetchToFile(target, nextCaptureEntry(policy, fetchLabel(target.url)), {
		net: policy.net,
		signal,
		hop: async (hop, redirected) => {
			// The first step was admitted above; a redirect is the server's choice of
			// where to go next, so it gets the host check but not the content check.
			if (redirected) {
				await gate.admitHost(TIN_FETCH, hop, ask, `GET ${hop.url.href} (redirected from ${target.url.href})`, once);
			}
		},
	});
	gate.history.push(request);
	return result;
}

// ---------------------------------------------------------------------------
// Cloning

/**
 * Branch (or tag) names tin_clone will pass along. Stricter than git's own rules,
 * which is fine for names people actually use, and it means the value can never be
 * read as an option or reach outside refs/.
 */
export function checkBranch(branch: string): void {
	const bad =
		branch === "" ||
		branch.length > 255 ||
		!/^[A-Za-z0-9._/-]+$/.test(branch) ||
		/^[-./]/.test(branch) ||
		/[/.]$/.test(branch) ||
		branch.endsWith(".lock") ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("/.");
	if (bad) {
		throw new TinDenied(
			`tin: "${branch}" is not a branch name tin_clone accepts: letters, digits, ".", "_", "-" and "/", ` +
				`not starting with "-", "." or "/".`,
		);
	}
}

/**
 * The whole git command line. Nothing in it comes from the model except the URL,
 * after `--`, and a branch that has been through checkBranch and is passed in the
 * `=` form, so neither can be read as an option.
 *
 * - protocol.allow pins the transports to http and https. That shuts out `ext::`,
 *   which runs a command, as well as ssh (your agent) and file:// (your disk).
 * - http.followRedirects=false, because a redirect git followed would be one tin
 *   never saw. A renamed repository fails with an error saying it moved.
 * - core.symlinks=false checks symlinks out as small text files. A reference copy
 *   loses nothing by it, and a link aimed somewhere surprising stays inert.
 * - --depth=1 and --single-branch keep it small; --no-tags keeps it to the branch.
 *   Submodules are never fetched, which is what most clone-time CVEs have needed.
 */
export function cloneArgs(target: NetTarget, dir: string, branch?: string): string[] {
	return [
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		"protocol.http.allow=always",
		"-c",
		"http.followRedirects=false",
		"clone",
		// --config rather than -c, so it is saved in the clone's own config: the
		// working tree has to agree with it later, or git status would report every
		// link as changed.
		"--config=core.symlinks=false",
		"--depth=1",
		"--single-branch",
		"--no-tags",
		...(branch === undefined ? [] : [`--branch=${branch}`]),
		"--",
		target.url.href,
		dir,
	];
}

// Environment that would hand git a program, a credential or a different route out.
// GIT_* covers GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EXEC_PATH and the GIT_CONFIG_*
// family; SSH_ASKPASS is git's last resort for prompting; NETRC names a credentials
// file to libcurl; the proxies are dropped because tin_fetch does not use one either,
// and the two should leave the machine the same way.
const CLONE_DROPPED_ENV = /^(?:GIT_.*|SSH_ASKPASS|SSH_AUTH_SOCK|NETRC|CURL_HOME|(?:HTTPS?|ALL|NO)_PROXY)$/i;

/**
 * Git's environment for a clone: yours, minus the above, with none of your git
 * configuration.
 *
 * GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=/dev/null are most of the hardening in
 * one move. They take away the credential helper (no quietly using your GitHub
 * token), url.insteadOf rewrites (no turning https into ssh and your agent), a
 * global hooksPath (post-checkout runs on clone), and filter drivers like git-lfs.
 * /dev/null is right on Windows too: Git for Windows maps it to NUL.
 *
 * HOME points at a directory that does not exist, so libcurl has no ~/.netrc to
 * send. It sits under the capture directory, which nothing is allowed to write.
 */
export function cloneEnv(home: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (typeof value === "string" && !CLONE_DROPPED_ENV.test(key)) env[key] = value;
	}
	return {
		...env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

const GIT: ResolvedCommand = { name: "git", link: "git", target: "git" };

/**
 * Run the clone itself.
 *
 * This is tin running git, not the model: the real git off pi's PATH, never the
 * read-only wrapper in binDir, with a command line the model has no part in beyond
 * the two values above. It goes through execCommand for the same timeout and
 * process-group kill that tin_run gets. A clone that fails is removed, since its
 * path is never handed out.
 */
export async function cloneInto(
	target: NetTarget,
	dir: string,
	branch: string | undefined,
	policy: TinPolicy,
	signal?: AbortSignal,
): Promise<void> {
	let outcome: ExecOutcome;
	try {
		outcome = await execCommand(GIT, cloneArgs(target, dir, branch), {
			cwd: policy.captureDir,
			env: cloneEnv(path.join(policy.captureDir, ".no-home")),
			policy: { ...policy, exec: { ...policy.exec, timeoutMs: policy.net.timeoutMs } },
			signal,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("tin: tin_clone needs git, and there is no git on PATH");
		}
		throw error;
	}
	if (outcome.exitCode === 0) return;

	rmSync(dir, { recursive: true, force: true });
	if (outcome.timedOut) {
		throw new Error(`tin: cloning ${target.url.href} timed out after ${Math.round(policy.net.timeoutMs / 1000)}s`);
	}
	if (outcome.signal !== null) throw new Error(`tin: cloning ${target.url.href} was cancelled`);
	throw new Error(
		`tin: git clone ${target.url.href} failed:\n${outcome.stderr.trim() || `exit code ${outcome.exitCode}`}`,
	);
}

/** The whole of tin_clone, minus the pi wiring. Returns the clone's path. */
export async function runClone(
	gate: NetGate,
	policy: TinPolicy,
	input: string,
	branch: string | undefined,
	ask: Ask,
	signal?: AbortSignal,
): Promise<string> {
	const target = parseTarget(input);
	if (branch !== undefined) checkBranch(branch);
	const request = `git clone ${target.url.href}${branch === undefined ? "" : ` (branch ${branch})`}`;
	await gate.admit(TIN_CLONE, target, ask, request, branch);

	const dir = nextCaptureEntry(policy, cloneLabel(target.url));
	await cloneInto(target, dir, branch, policy, signal);
	gate.history.push(request);
	return dir;
}
