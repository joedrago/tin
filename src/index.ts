import { readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { Type } from "typebox";
import { buildPolicy, saveHostEntry, type TinPolicy } from "./config.ts";
import {
	type Answer,
	type Ask,
	formatFetch,
	NetGate,
	runClone,
	runFetch,
	TIN_CLONE,
	TIN_FETCH,
} from "./net.ts";
import {
	allowedToolNames,
	decideToolCall,
	describePolicy,
	describeTinjs,
	describeWriteRoots,
	TIN_RUN,
} from "./policy.ts";
import {
	buildChildEnv,
	execCommand,
	formatOutcome,
	listCommands,
	nextCapturePath,
	resetCaptureSequence,
	resolveCommand,
	resolveWorkingDirectory,
	TinDenied,
} from "./run.ts";

/**
 * Write roots granted to one session, listed the way PATH is: a delimiter-separated
 * list of directories, added to the configured roots rather than replacing them.
 * `bin/tin` sets it from its command line.
 *
 * It is read from pi's own environment once, at session start. Allowed commands do
 * inherit it by default, but seeing it grants nothing — the roots it names are already
 * in the system prompt and in /tin. What matters is that nothing the model runs can
 * *set* it for a later session: tin_run takes a command and an argument array and no
 * environment, so the only way in is the process that started pi.
 */
export const EXTRA_ROOTS_ENV = "TIN_EXTRA_WRITE_ROOTS";

function extraWriteRootsFromEnv(): string[] {
	const raw = process.env[EXTRA_ROOTS_ENV];
	if (!raw) return [];
	return raw.split(path.delimiter).filter((entry) => entry.trim() !== "");
}

const runSchema = Type.Object({
	command: Type.String({
		description: "Name of an allowed command, exactly as it is linked in the command directory",
	}),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Arguments passed verbatim to the command. No shell is used: globs, pipes, redirection and $(...) are not expanded.",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory. Must be inside a writable root." }),
	),
	capture: Type.Optional(
		Type.Boolean({
			description:
				"Write this command's stdout to a file instead of returning all of it. The result gives you the file's path, size and first lines; pass that path to another command (tinjs reads a large file with lines()) to work on the whole thing. Use it when the output is large or is meant as input to the next step. stderr comes back either way.",
		}),
	),
});

const fetchSchema = Type.Object({
	url: Type.String({ description: "The http or https URL to GET." }),
});

const cloneSchema = Type.Object({
	url: Type.String({ description: "The http or https URL of a git repository." }),
	branch: Type.Optional(
		Type.String({ description: "Branch or tag to check out. The remote's default branch if omitted." }),
	),
});

// pi's select resolves undefined both when its timeout runs out and when the user
// presses Esc, and the two mean different things here: one is nobody there, the
// other is a no. The countdown is the only clock, so an empty answer that arrives
// within this much of the deadline is taken to be the countdown's.
const ASK_TIMEOUT_SLACK_MS = 1_000;

/**
 * Put a question to the user, and say which way it ended. The tool's own signal is
 * passed along so cancelling the turn closes the question instead of leaving it up.
 */
function askerFor(ctx: ExtensionContext, timeoutMs: number, signal?: AbortSignal): Ask {
	return async (title, options): Promise<Answer> => {
		if (!ctx.hasUI) return { kind: "unavailable" };
		const startedAt = Date.now();
		const choice = await ctx.ui.select(title, options, { timeout: timeoutMs, signal });
		if (choice !== undefined) return { kind: "chose", index: options.indexOf(choice) };
		if (signal?.aborted) return { kind: "aborted" };
		if (Date.now() - startedAt >= timeoutMs - ASK_TIMEOUT_SLACK_MS) return { kind: "timeout" };
		return { kind: "dismissed" };
	};
}

export interface TinRunDetails {
	command: string;
	args: string[];
	/** What the allowlist entry actually points at. */
	resolved: string;
	cwd: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
	/** Where stdout was captured, when it was. */
	capturePath?: string;
	captureBytes?: number;
}

export default function tin(pi: ExtensionAPI) {
	let policy: TinPolicy | undefined;
	let gate: NetGate | undefined;

	function policyFor(ctx: ExtensionContext): TinPolicy {
		if (!policy) {
			policy = buildPolicy({
				cwd: ctx.cwd,
				home: os.homedir(),
				agentDir: getAgentDir(),
				extraWriteRoots: extraWriteRootsFromEnv(),
			});
		}
		return policy;
	}

	/** The session's approvals, which last exactly as long as its policy does. */
	function gateFor(ctx: ExtensionContext): NetGate {
		const active = policyFor(ctx);
		gate ??= new NetGate(active.net, (list, entry) => {
			// "Always allow" or "Always deny". The gate has already applied the answer
			// for this session by the time this runs, so a file that cannot be written
			// costs the permanence and nothing else — worth saying, not worth failing
			// the call over.
			try {
				saveHostEntry(active.configPath, list, entry, active.net[list]);
				active.net[list].push(entry);
				ctx.ui.notify(`tin: added ${entry} to net.${list} in ${active.configPath}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`tin: could not save ${entry} to net.${list} in ${active.configPath} (${(error as Error).message}); it holds for this session only`,
					"warning",
				);
			}
		});
		return gate;
	}

	pi.registerTool<typeof runSchema, TinRunDetails | undefined>({
		name: TIN_RUN,
		label: "Run",
		description:
			"Run one of the commands the user has explicitly allowed. The command is executed directly " +
			"with the given argument array — there is no shell, so pipes, redirection, globs, environment " +
			"expansion and command substitution do not work. Pass each argument as its own array element.",
		promptSnippet: "Run an allowed command (no shell)",
		promptGuidelines: [
			"Use tin_run instead of bash; the bash and powershell tools are disabled in this session.",
			"tin_run takes a bare command name plus an args array. Shell syntax such as |, >, && and $(...) is not interpreted and will be passed through as literal arguments.",
			"There is no pipe, but capture: true is how output reaches another command: it writes stdout to a file and gives you the path, which you then pass as an argument to the next one. Reach for it when output is large or is the input to a later step, rather than pulling it all back through the conversation.",
		],
		parameters: runSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const active = policyFor(ctx);
			const args = params.args ?? [];

			// TinDenied carries a message written for the model; rethrowing marks the
			// tool result as an error so the model sees it and can adapt.
			const command = resolveCommand(params.command, active);
			const cwd = resolveWorkingDirectory(params.cwd, active, ctx.cwd);

			onUpdate?.({
				content: [{ type: "text", text: `${params.command} ${args.join(" ")}` }],
				details: undefined,
			});

			const capturePath = params.capture ? nextCapturePath(active, params.command) : undefined;

			const outcome = await execCommand(
				command,
				args,
				{ cwd, env: buildChildEnv(active), policy: active, signal, capturePath },
				(_stream, text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
			);

			return {
				content: [{ type: "text", text: formatOutcome(params.command, args, outcome) }],
				details: {
					command: params.command,
					args,
					resolved: command.target,
					cwd,
					exitCode: outcome.exitCode,
					timedOut: outcome.timedOut,
					truncated: outcome.truncated,
					durationMs: outcome.durationMs,
					capturePath: outcome.capture?.path,
					captureBytes: outcome.capture?.bytes,
				},
			};
		},
	});

	pi.registerTool<typeof fetchSchema, TinFetchDetails | undefined>({
		name: TIN_FETCH,
		label: "Fetch",
		description:
			"Download one URL with a plain GET — no cookies, no credentials, no custom headers — to a file tin " +
			"chooses outside the workspace, and return its path. Hosts not on the user's allowed list, and URLs " +
			"that look like they carry data, wait for the user to approve them.",
		promptSnippet: "GET one URL into a file and return its path",
		promptGuidelines: [
			"tin_fetch returns a path rather than the content: read it with read, or pass it to a command. Prefer raw URLs (raw.githubusercontent.com rather than a github.com/blob page) so the file is the document and not the page around it.",
		],
		parameters: fetchSchema,
		// One at a time, so two requests never put two questions up at once, and a
		// host allowed by the first is already allowed when the second is checked.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const active = policyFor(ctx);
			onUpdate?.({ content: [{ type: "text", text: `GET ${params.url}` }], details: undefined });
			const ask = askerFor(ctx, active.net.askTimeoutMs, signal);
			const result = await runFetch(gateFor(ctx), active, params.url, ask, signal);
			return {
				content: [{ type: "text", text: formatFetch(result) }],
				details: {
					url: params.url,
					finalUrl: result.finalUrl,
					path: result.path,
					status: result.status,
					bytes: result.bytes,
				},
			};
		},
	});

	pi.registerTool<typeof cloneSchema, TinCloneDetails | undefined>({
		name: TIN_CLONE,
		label: "Clone",
		description:
			"Make a shallow (depth 1) clone of a git repository over http or https into a directory tin chooses " +
			"outside the workspace, and return its path. Anonymous: none of the user's git credentials or " +
			"configuration are used. Hosts not on the user's allowed list wait for the user to approve them.",
		promptSnippet: "Shallow-clone a git repository and return its path",
		promptGuidelines: [
			"tin_clone returns the path of a read-only reference copy: read, ls, grep and find work in it, and so does git if it is an allowed command, as `git -C <path> log` (it is a depth-1 clone, so there is one commit). It is not writable and is not a place to build or run anything.",
		],
		parameters: cloneSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const active = policyFor(ctx);
			onUpdate?.({ content: [{ type: "text", text: `git clone ${params.url}` }], details: undefined });
			const ask = askerFor(ctx, active.net.askTimeoutMs, signal);
			const dir = await runClone(gateFor(ctx), active, params.url, params.branch, ask, signal);
			return {
				content: [{ type: "text", text: dir }],
				details: { url: params.url, branch: params.branch, path: dir },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		policy = undefined;
		gate = undefined;
		resetCaptureSequence();
		const active = policyFor(ctx);

		// Take bash, powershell, and anything else unexpected out of the model's view
		// entirely, rather than only blocking them once they are called.
		const allowed = new Set(allowedToolNames(active));
		pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => allowed.has(name)));

		ctx.ui.setStatus("tin", describePolicy(active));
		ctx.ui.notify(describeWriteRoots(active), "info");
		for (const warning of active.warnings) ctx.ui.notify(warning, "warning");
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = decideToolCall(event.toolName, event.input, policyFor(ctx), ctx.cwd);
		if (!decision.allow) return { block: true, reason: decision.reason };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const active = policyFor(ctx);
		const commands = listCommands(active);
		const lines = [
			"# tin",
			"",
			"This session runs under tin, a restricted capability set:",
			"",
			"- Reading is unrestricted: read, ls, grep and find work anywhere on this machine.",
			`- Writing is limited to ${active.writeRoots.join(", ") || "nowhere"}. Paths are resolved through symlinks before the check, and ${active.denySegments.join(", ")} are protected.`,
			"- There is no shell. bash and powershell are unavailable.",
			commands.length > 0
				? `- tin_run executes exactly these commands, with an argument array and no shell: ${commands.join(", ")}.`
				: "- tin_run has no commands available, so nothing can be executed this session.",
			...describeTinjs(commands),
			"",
			"Denials come back as tool errors explaining the rule. They are policy, not transient failures: do not retry the same call, and do not try to work around the restriction. If a task needs something outside these limits, say so and stop.",
		];
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});

	pi.registerCommand("tin", {
		description: "Show the active tin policy",
		handler: async (_args, ctx) => {
			const active = policyFor(ctx);
			const commands = listCommands(active);
			const report = [
				`config      ${active.configPath}`,
				`workspace   ${active.workspace}`,
				`write roots ${active.writeRoots.join(", ") || "(none)"}`,
				...(active.extraWriteRoots.length > 0
					? [`  of which ${active.extraWriteRoots.join(", ")} came from ${EXTRA_ROOTS_ENV}`]
					: []),
				`protected   ${active.denySegments.join(", ")} + ${active.denyPaths.join(", ")}`,
				`captures    ${captureState(active.captureDir)}`,
				`commands    ${active.execEnabled ? active.binDir : "(execution disabled)"}`,
				`            ${commands.join(", ") || "(none linked)"}`,
				`environment ${describeChildEnv(active)}`,
				...active.warnings.map((warning) => `warning     ${warning}`),
			];
			ctx.ui.notify(report.join("\n"), active.warnings.length > 0 ? "warning" : "info");
		},
	});
}

export interface TinFetchDetails {
	url: string;
	finalUrl: string;
	path: string;
	status: number;
	bytes: number;
}

export interface TinCloneDetails {
	url: string;
	branch?: string;
	path: string;
}

/**
 * What to tell the model about the network tools. The part worth the tokens is the
 * last line: a model that reads "the user did not answer" as "the user said no"
 * gives up on the task, and one that does not know the difference retries until
 * someone comes back.
 */
function describeNet(policy: TinPolicy): string[] {
	if (!policy.net.enabled) return ["- There is no network access."];
	return [
		`- tin_fetch GETs one URL into a file and returns its path; tin_clone makes a shallow, anonymous clone of a git repository and returns its path. Both write only under tin's own temporary directory, never the workspace.`,
		`  - Reached without asking: ${policy.net.allowHosts.join(", ") || "(no hosts)"}. Any other host, and any URL that looks like it is carrying data, waits for the user to approve it.`,
		`  - A denial that says nobody answered is not a refusal: the user is away. Do not retry it; finish what you can without it and mention that it is waiting on their approval.`,
	];
}

/** The network lines in /tin. */
function describeNetState(policy: TinPolicy, gate: NetGate | undefined): string[] {
	if (!policy.net.enabled) return ["network     off (net.enabled is false)"];
	const lines = [
		`network     GET and shallow clone; asks about unlisted hosts, waiting ${Math.round(policy.net.askTimeoutMs / 1000)}s`,
		`            allowed: ${policy.net.allowHosts.join(", ") || "(none)"}`,
		`            denied:  ${policy.net.denyHosts.join(", ") || "(none)"}`,
	];
	const session = gate?.sessionAllowed ?? [];
	if (session.length > 0) lines.push(`            this session only: ${session.join(", ")}`);
	const history = gate?.history ?? [];
	if (history.length > 0) {
		lines.push(`            ${history.length} request${history.length === 1 ? "" : "s"} this session:`);
		lines.push(...history.map((request) => `              ${request}`));
	}
	return lines;
}

/**
 * What an allowed command's environment looks like, for /tin.
 *
 * Worth a line of its own because it is the one policy here whose default is the
 * permissive one, so "inherited" should be something you saw rather than assumed.
 */
function describeChildEnv(policy: TinPolicy): string {
	const pinned = Object.keys(policy.exec.env);
	const overrides = pinned.length > 0 ? `, then exec.env pins ${pinned.join(", ")}` : "";
	return policy.exec.inheritEnv
		? `inherited from pi, PATH and all${overrides}`
		: `built from scratch, PATH is ${policy.binDir}, carrying ${policy.exec.passEnv.join(", ") || "nothing"}${overrides}`;
}

/**
 * What to say about the capture directory in /tin.
 *
 * Whether it exists is the useful part: tin never removes a capture file, on the
 * grounds that a path handed out two days ago should still work, so this is also
 * where to look when you want the disk back. Nothing to say if the session has
 * not captured anything, which is most of them.
 */
function captureState(dir: string): string {
	try {
		const names = readdirSync(dir);
		return `${dir} (${names.length} file${names.length === 1 ? "" : "s"}; tin never removes them)`;
	} catch {
		return `${dir} (nothing captured yet)`;
	}
}

export type { TinPolicy };
export { TinDenied };
