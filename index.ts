/**
 * Devcontainer Extension - a `devcontainer` tool that runs commands inside
 * the project's devcontainer.
 *
 * The tool exists because silently rerouting `bash` into a container is
 * confusing in a way that no description can fix: the `<cwd>` in pi's system
 * prompt stays a HOST path, so the model reads it, types it into a command,
 * and the command fails because that path does not exist in the container.
 * Same tool, two filesystems, no signal that a switch happened.
 *
 * So nothing is rerouted. `bash` (and `!`/`!!`) stay on the host. This
 * extension registers one extra tool, `devcontainer`, whose `cwd` is
 * interpreted as a CONTAINER path and whose result reports both the
 * container path and the host path of the directory it ran in, so `read`,
 * `edit` and `write` can still target the same files from the host side.
 *
 * The tool is registered at startup and only made ACTIVE once the container
 * is actually available, so a project without a devcontainer — or one whose
 * container failed to start — sees no such tool at all.
 *
 * If the PROJECT DIRECTORY ITSELF — and only that directory, no parent
 * search — contains `.devcontainer/devcontainer.json` (or `devcontainer.json`
 * directly, for backward compatibility) and pi is not already running
 * inside a devcontainer:
 *
 * - With the `devcontainer` CLI available, commands run via
 *   `devcontainer exec --workspace-folder <project> -- bash -c '<cmd>'`.
 *   `devcontainer up` is kicked off in the BACKGROUND at session start
 *   (never blocking the prompt — a first-run image pull can take a long
 *   time); the first tool call waits for it to finish. `exec` alone does not
 *   create/attach the container (it fails with "Dev container not found"
 *   until `up` has run). If `up` fails the tool stays inactive and commands
 *   simply run on the host via `bash`, with a one-time warning.
 * - Otherwise it falls back to plain docker, using the `image` field from
 *   devcontainer.json: it creates/starts a container
 *   `pi-devcontainer-<project>` that mounts the project at its current path
 *   and keeps it alive with `tail -f /dev/null`.
 *
 * Build-based devcontainers (no `image` field) require the devcontainer CLI;
 * without it the tool is never activated.
 *
 * Usage:
 * - `pi --no-devcontainer` - do not offer the tool for this run
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

import { alreadyInContainer, hasDevcontainerCli, loadDevcontainerJson } from "./config.js";
import { ensureDockerContainer } from "./docker.js";
import { run } from "./exec.js";
import { loadGlobalOverride } from "./override.js";
import { provisionContainer } from "./provision.js";
import { ensureReady, runInContainer } from "./run-in-container.js";
import type { DevcontainerConfig } from "./types.js";

const TOOL_NAME = "devcontainer";
const DEFAULT_TIMEOUT = 120;

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-devcontainer", {
		description: "Do not offer the devcontainer tool for this session",
		type: "boolean",
		default: false,
	});

	let cfg: DevcontainerConfig | null = null;
	let shuttingDown = false;
	// The tool is registered unconditionally (pi requires registration before
	// setActiveTools can name it) but kept INACTIVE until the container is
	// known to be up. A project with no devcontainer, or one whose container
	// failed to start, therefore never shows a tool it cannot serve.
	let active = false;
	let lastUi: ExtensionUIContext | null = null;

	const notify = (msg: string, level: "info" | "warning" | "error") => {
		if (!shuttingDown) lastUi?.notify?.(msg, level);
	};

	// Changing the active tool set is transcript-visible (pi appends it before
	// the next model request), so each transition is guarded to run once and
	// never during shutdown. A session that refuses the change still works:
	// `execute` checks `active` itself and fails loudly.
	const setToolActive = (next: boolean) => {
		if (active === next) return;
		active = next;
		if (shuttingDown) return;
		try {
			const names = pi.getActiveTools();
			pi.setActiveTools(next ? [...names, TOOL_NAME] : names.filter((n) => n !== TOOL_NAME));
		} catch {
			// see above: `active` is the real gate
		}
	};

	const devcontainerTool = defineTool({
		name: TOOL_NAME,
		label: "Devcontainer",
		description: [
			"Run a shell command INSIDE this project's devcontainer, using the same toolchain, user and filesystem the container has.",
			"",
			"`bash` runs on the HOST. This tool runs in the CONTAINER. The two see different filesystems, so use this tool for anything that must be built, tested, installed or run by the container's toolchain (compilers, language runtimes, package managers, project commands).",
			"",
			"Parameters:",
			"- `command` (required): the shell command, run with `bash -c` (non-login: profile scripts do not run).",
			"- `cwd` (optional): directory to run in, relative to the workspace root inside the container, or an absolute CONTAINER path. Omit it for the workspace root. A host path does not exist here; the result reports the host path of the directory actually used so `read`/`edit`/`write` can target the same files.",
			"- `stdin` (optional): text piped to the command's standard input. Use it for heredocs and piped input instead of shell redirection to a file.",
			"- `timeout` (optional): seconds before the command is killed (default 120).",
		].join("\n"),
		promptSnippet: "Run a shell command inside this project's devcontainer",
		promptGuidelines: [
			"`bash` runs on the host filesystem; the `devcontainer` tool runs inside the container. Build, test and dependency commands that need the container's toolchain belong in `devcontainer`; file inspection and editing belong in `read`/`edit`/`write`, which use the host path this tool reports.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run inside the container" }),
			cwd: Type.Optional(
				Type.String({
					description:
						"Directory relative to the container workspace root, or an absolute container path. Defaults to the workspace root.",
				}),
			),
			stdin: Type.Optional(Type.String({ description: "Text piped to the command's stdin" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds before the command is killed (default 120)" })),
		}),
		renderShell: "default",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const current = cfg;
			if (!active || !current) {
				throw new Error(
					"the devcontainer is not available; run this command with `bash` on the host instead",
				);
			}
			await ensureReady(current, () => active);

			const timeout = params.timeout === undefined || params.timeout <= 0 ? DEFAULT_TIMEOUT : params.timeout;
			const result = await runInContainer(current, { ...params, timeout }, undefined, signal);

			if (result.failure === "aborted") throw new Error("aborted");
			if (result.failure?.startsWith("timeout:")) {
				throw new Error(`devcontainer command timed out after ${timeout} seconds (cwd ${result.containerCwd})`);
			}

			const truncated = truncateTail(result.output);
			const header = [
				`container cwd: ${result.containerCwd}`,
				`host cwd: ${result.hostCwd}`,
				`exit code: ${result.exitCode}`,
			].join("\n");
			const text = [
				header,
				truncated.content,
				truncated.truncated
					? `[output truncated: ${truncated.totalLines} lines / ${truncated.totalBytes} bytes total, showing last ${truncated.outputLines} lines]`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			if (result.exitCode !== 0) {
				// A non-zero exit is an ordinary command outcome, not a broken
				// container, so nothing is torn down — but the model must SEE it
				// as a failure, which only throwing achieves.
				throw new Error(
					`devcontainer command exited with code ${result.exitCode} (cwd ${result.containerCwd})\n${truncated.content}`,
				);
			}
			return {
				content: [{ type: "text", text }],
				details: {
					exitCode: result.exitCode,
					containerCwd: result.containerCwd,
					hostCwd: result.hostCwd,
					truncated: truncated.truncated || undefined,
				},
			};
		},
	});

	pi.registerTool(devcontainerTool);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		lastUi = ctx.ui;
		// Registered but not offered: pi records the tool set in the
		// transcript's first system message, so leaving it active in a project
		// with no devcontainer would advertise a command the model cannot use.
		// Done at the very start of session_start, before any await, so it
		// lands before the prompt is built.
		setToolActive(false);

		if (pi.getFlag("no-devcontainer") === true) return;
		if (alreadyInContainer()) return;

		const { config, path, root } = loadDevcontainerJson(ctx.cwd);
		if (!path) return; // no devcontainer in this project
		if (!config) {
			notify(`Devcontainer file exists but could not be parsed: ${path}`, "error");
			return;
		}

		const image = typeof config.image === "string" ? config.image : undefined;
		const configRoot = root ?? ctx.cwd;
		// The `workspaceFolder` config field (when set) names the folder to
		// bind-mount; a relative value is resolved against the config's
		// directory. Otherwise the config's directory is the workspace root.
		// Honored by the DOCKER FALLBACK only: the devcontainer CLI resolves
		// its config at <folder>/.devcontainer/ and never searches upward, so
		// CLI mode must be pointed at the config root instead (see
		// cfg.workspaceFolder below).
		let declaredWorkspaceFolder: string;
		if (typeof config.workspaceFolder === "string" && config.workspaceFolder !== "") {
			const rawWf = config.workspaceFolder;
			declaredWorkspaceFolder = isAbsolute(rawWf) ? rawWf : resolve(configRoot, rawWf);
			try {
				declaredWorkspaceFolder = realpathSync(declaredWorkspaceFolder);
			} catch {
				// keep the unresolved path
			}
		} else {
			declaredWorkspaceFolder = configRoot;
		}
		const useCli = await hasDevcontainerCli();
		let canonicalCwd = ctx.cwd;
		try {
			canonicalCwd = realpathSync(ctx.cwd);
		} catch {
			// fall back to the raw cwd
		}
		cfg = {
			projectCwd: ctx.cwd,
			canonicalCwd,
			configRoot: canonicalCwd,
			// Include a short hash of the canonical path: two projects sharing a
			// basename (e.g. ~/work/api and ~/oss/api) would otherwise collide
			// on one container name, and `ensureDockerContainer` would happily
			// `docker start` the OTHER project's container and run every
			// command against the wrong mount.
			containerName: `pi-devcontainer-${basename(ctx.cwd)}-${createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 6)}`,
			image,
			// Overwritten below once the execution mode is known.
			workspaceFolder: declaredWorkspaceFolder,
			useCli,
		};

		if (!useCli && !image) {
			notify(
				"devcontainer.json uses build/dockerCompose and the devcontainer CLI is not installed; the devcontainer tool stays unavailable",
				"warning",
			);
			cfg = null;
			return;
		}

		// A single "what is happening now" notice: the CLI/docker bring-up
		// later reports readiness. Three toasts per session was noise.
		notify(
			useCli
				? "Starting devcontainer in the background (first run may take a while); the devcontainer tool activates when it is ready..."
				: "Starting devcontainer container in the background (first run may pull the image)...",
			"info",
		);

		// Loaded once and shared by both execution modes.
		const override = loadGlobalOverride();

		if (cfg.useCli) {
			// `devcontainer exec` does not create the container on its own —
			// it fails with "Dev container not found" until `up` has run.
			// Run `up` in the BACKGROUND: a first-run image pull can take
			// many minutes and must not block the prompt (session start).
			// The first tool call awaits cfg.pendingUp before it runs.
			// NOTE: no --quiet flag — it was removed from the devcontainer
			// CLI (0.89.0 rejects it with "Unknown argument: quiet"). Output
			// is piped away anyway.
			// The CLI bind-mounts the folder it was given and resolves the
			// config at <folder>/.devcontainer/ — it does NOT search upward —
			// so pass the canonical (symlink-resolved) host path of the
			// directory containing the config (the config root), not the
			// project cwd. A path the kernel sees differently (e.g.
			// /home/... vs /var/home/...) ends up mounted from the wrong
			// host directory, hence canonicalization.
			const wsFolder = cfg.configRoot;
			const upArgs = ["up", "--workspace-folder", wsFolder];
			if (override.features && Object.keys(override.features).length > 0) {
				upArgs.push("--additional-features", JSON.stringify(override.features));
			}
			// exec's --workspace-folder must match the folder used for up.
			cfg.workspaceFolder = wsFolder;
			// Bring the container up in the background and resolve where the
			// workspace is mounted (e.g. /workspaces/<name>); the first
			// command awaits this promise. On failure the tool is never
			// activated and pendingUp is rejected, so a call made in the
			// window reports a clear error instead of a container-less exec.
			const c = cfg;
			c.pendingUp = (async () => {
				const up = await run("devcontainer", upArgs);
				if (up.code !== 0) {
					const detail = up.stderr.trim().split("\n").slice(0, 3).join(" ");
					throw new Error(detail || `devcontainer up exited ${up.code}`);
				}
				// `devcontainer up` prints a JSON line with
				// remoteWorkspaceFolder (e.g. /workspaces/<name>) — use it.
				// Probing with `bash -lc "printf %s $PWD"` does NOT work:
				// the exec shell starts at the container's default cwd, not
				// the workspace.
				const jsonLine = up.stdout
					.trim()
					.split("\n")
					.map((l) => l.trim())
					.find((l) => l.startsWith("{"));
				let remoteWorkspace: string | undefined;
				try {
					const obj = jsonLine ? JSON.parse(jsonLine) : null;
					if (obj && typeof obj.remoteWorkspaceFolder === "string") {
						remoteWorkspace = obj.remoteWorkspaceFolder;
					}
				} catch {
					// fall through to the probe
				}
				if (!remoteWorkspace) {
					const probe = await run("devcontainer", [
						"exec",
						"--workspace-folder",
						wsFolder,
						"--",
						"bash",
						"-c",
						// `cd` must succeed — the exec default cwd can be a host
						// path that does not exist in the container, and bash -c
						// does not propagate cd failures to the exit code.
						"cd \"$DEVCONTAINER_WORKSPACE_FOLDER\" 2>/dev/null && printf %s \"$PWD\"",
					]);
					if (probe.code === 0 && probe.stdout.trim()) {
						remoteWorkspace = probe.stdout.trim();
					} else {
						notify(
							"devcontainer workspace probe failed; pass an absolute container path as `cwd`, or omit it to use the container's default working directory",
							"warning",
						);
					}
				}
				if (remoteWorkspace) {
					c.remoteWorkspace = remoteWorkspace;
				}
				if (override.provision && override.provision.length > 0) {
					await provisionContainer(
						notify,
						["devcontainer", "exec", "--workspace-folder", wsFolder, "--"],
						override.provision,
						// Same object handed to `--additional-features` above, so
						// the provisioning marker key tracks the image rebuild
						// the CLI is about to perform.
						override.features,
					);
				}
				setToolActive(true);
				notify(
					`Devcontainer ready: ${c.containerName} — the devcontainer tool runs commands with cwd ${c.remoteWorkspace ?? "(container default)"} (host: ${c.projectCwd})`,
					"info",
				);
			})();
		} else {
			// docker fallback: bring the container up in the background (a
			// first-run image pull can take a long time and must not block the
			// prompt). The declared `workspaceFolder` is honored here (the CLI
			// cannot be pointed at it) and the mount keeps the host path valid
			// inside the container. Provisioning runs afterwards; its marker
			// lives in the container's own $HOME — which is root for most
			// images but NOT forced (see ensureDockerContainer).
			const c = cfg;
			c.workspaceFolder = declaredWorkspaceFolder;
			if (override.features && Object.keys(override.features).length > 0) {
				notify(
					"pi-override.json declares features, which only the devcontainer CLI can apply — install the CLI to get them in docker-fallback mode",
					"warning",
				);
			}
			c.pendingUp = (async () => {
				await ensureDockerContainer(c);
				if (override.provision && override.provision.length > 0) {
					await provisionContainer(notify, ["docker", "exec", c.containerName], override.provision);
				}
				setToolActive(true);
				notify(
					`Devcontainer ready: ${c.containerName} — workspace mounted at ${c.workspaceFolder} (host paths stay valid)`,
					"info",
				);
			})();
		}

		// Bring-up failures are reported here rather than left as an unhandled
		// rejection: the background promise is awaited by the first tool call,
		// but a session that never calls the tool would otherwise surface a
		// raw rejection instead of the actionable message.
		// SAFETY: both branches above assign `c.pendingUp`, and `c` is the
		// same object `cfg` points at. The assertion documents that the
		// catch below is watching the promise both of them created.
		(cfg.pendingUp as Promise<void>).catch((err: unknown) => {
			notify(
				`devcontainer unavailable — the devcontainer tool will not be offered: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		});
	});

	pi.on("session_shutdown", () => {
		// Set before clearing so an in-flight background `up` does not emit
		// notifications (or hold the process open) after the session ends.
		shuttingDown = true;
		active = false;
		cfg = null;
		lastUi = null;
	});
}
