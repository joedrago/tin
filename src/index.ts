import { readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { Type } from "typebox";
import { buildPolicy, type TinPolicy } from "./config.ts";
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
 * It is read from pi's own environment, which is not somewhere the model can reach:
 * tin_run builds its child environment from scratch, so nothing the model runs can
 * set this for a later session, and the variable is consulted once at session start.
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

	pi.on("session_start", async (_event, ctx) => {
		policy = undefined;
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
				...active.warnings.map((warning) => `warning     ${warning}`),
			];
			ctx.ui.notify(report.join("\n"), active.warnings.length > 0 ? "warning" : "info");
		},
	});
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
