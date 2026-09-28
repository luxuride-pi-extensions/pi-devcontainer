/**
 * Devcontainer Extension - run pi's bash inside the project's devcontainer
 *
 * If the PROJECT DIRECTORY ITSELF — and only that directory, no parent
 * search — contains `.devcontainer/devcontainer.json` (or `devcontainer.json`
 * directly, for backward compatibility) and pi is not already running
 * inside a devcontainer,
 * this extension proxies the `bash` tool (and `!`/`!!` user bash) into the
 * devcontainer:
 *
 * - If the `devcontainer` CLI is available, commands run via
 *   `devcontainer exec --workspace-folder <project> -- bash -lc '<cmd>'`.
 *   At session start the extension runs
 *   `devcontainer up --workspace-folder <project>` is kicked off in the
 *   background at session start (never blocking the prompt — a first-run
 *   image pull can take a long time); the first command waits for it to
 *   finish. `exec` alone does not create/attach the container (it fails
 *   with "Dev container not found" until `up` has run). If `up` fails the
 *   proxy is disabled and commands fall back to the local shell. The same
 *   fail-safe re-triggers on any executor spawn failure.
 * - Otherwise it falls back to plain docker, using the `image` field from
 *   devcontainer.json: it creates/starts a container
 *   `pi-devcontainer-<project>` that mounts the project at its current path
 *   and keeps it alive with `tail -f /dev/null`.
 *
 * Build-based devcontainers (no `image` field) require the devcontainer CLI;
 * without it the extension disables itself with a warning.
 *
 * Usage:
 * - `pi --no-devcontainer` - disable proxying for this run
 * - `/devcontainer` - show current devcontainer status
 * - `/devcontainer on|off` - enable/disable proxying for this session
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool } from "@earendil-works/pi-coding-agent";

import { createContainerOps, settleBringUp } from "./container-ops.js";
import { alreadyInContainer, hasDevcontainerCli, loadDevcontainerJson } from "./config.js";
import { ensureDockerContainer } from "./docker.js";
import { isProxyBreakError } from "./errors.js";
import { run } from "./exec.js";
import { loadGlobalOverride } from "./override.js";
import { provisionContainer } from "./provision.js";
import type { DevcontainerConfig, StatusUI } from "./types.js";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-devcontainer", {
		description: "Disable devcontainer proxying for bash commands",
		type: "boolean",
		default: false,
	});

	let cfg: DevcontainerConfig | null = null;
	let enabled = false;
	let lastUi: StatusUI | null = null;

	const setStatus = (ui?: StatusUI) => {
		const uiRef = ui ?? lastUi;
		if (!uiRef) return;
		// containerOps is part of the condition on purpose: `disableProxy`
		// nulls it while leaving `cfg` intact, and `/devcontainer on` can
		// flip `enabled` back before ops are rebuilt. Advertising the
		// container in the status bar while `execute` quietly falls through
		// to the LOCAL shell is worse than showing nothing.
		if (enabled && cfg && containerOps) {
			// Short label: the full container name overflows narrow terminals
			// and is redundant with `/devcontainer`.
			uiRef.setStatus("devcontainer", uiRef.theme.fg("accent", `🐳 devcontainer: ${basename(cfg.projectCwd)}`));
		} else {
			uiRef.setStatus("devcontainer", undefined);
		}
	};

	let shuttingDown = false;

	const disableProxy = (reason: string) => {
		enabled = false;
		containerOps = null;
		setStatus();
		if (!shuttingDown) lastUi?.notify?.(`Devcontainer proxying disabled — ${reason}`, "error");
	};

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);
	// Built once per session, not per bash call: the ops closure must observe
	// the CURRENT `enabled` value, and rebuilding it per command kept
	// re-capturing stale state.
	let containerOps: BashOperations | null = null;
	// Factory captured at session start so `/devcontainer on` can rebuild
	// ops after a `disableProxy` (bring-up failure, spawn error) instead of
	// re-enabling a session whose container is known-bad.
	let containerOpsFactory: (() => BashOperations) | null = null;

	// Replace the built-in bash tool: same name/schema, routed into the container when enabled.
	pi.registerTool({
		...localBash,
		label: "bash",
		...(localBash.description
			? { description: localBash.description + " \n\nDevcontainer note: when bash is proxied into a devcontainer, this command runs INSIDE the container. The <cwd> shown in the system prompt is a HOST path and usually does not exist in the container. The shell's working directory is already the mapped workspace. PI_HOST_CWD holds the host workspace path; when the devcontainer CLI is in use, PI_DEVCONTAINER_WORKSPACE holds the container workspace path — prefer it (or relative paths) over typing host absolute paths. Host files outside the workspace (e.g. ~/.pi) are not reachable from here." }
			: {}),
			async execute(id, params, signal, onUpdate, _ctx) {
				if (!enabled || !cfg || !containerOps) return localBash.execute(id, params, signal, onUpdate);
				// The container may still be starting in the background
				// (session start never blocks on `devcontainer up`). Wait
				// for it; if it failed, the proxy is already disabled — run
				// the command locally, matching the old "up failed → proxy
				// off" behavior. settleBringUp is shared with the ops layer
				// so the two call sites cannot disagree on what counts as
				// bring-up failure.
				try {
					await settleBringUp(cfg, () => enabled);
				} catch {
					return localBash.execute(id, params, signal, onUpdate);
				}
				const containerBash = createBashTool(localCwd, { operations: containerOps });
				try {
					return await containerBash.execute(id, params, signal, onUpdate);
				} catch (err) {
					// pi's bash tool throws on every non-zero exit, timeout and
					// abort — a command that simply failed inside a healthy
					// container must NOT disable the proxy. Only a failure to
					// run the command in the container may (it then falls back
					// to the local shell for later commands).
					if (enabled && isProxyBreakError(err)) {
						disableProxy(`devcontainer proxy failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					throw err;
				}
			},
	});

	// Route `!`/`!!` user bash through the container as well.
	// The tool path catches and classifies exec rejections; this path has no
	// such wrapper, so a plumbing failure (bring-up rejected, docker missing,
	// spawn ENOENT) would surface as a raw Error with no notification. Convert
	// those into a reported non-zero exit so `!cmd` degrades to a visible
	// message instead of an unhandled rejection. Ordinary non-zero exits
	// already arrive as { exitCode } and pass through untouched.
	let warnedUserBash = false;
	const userBashOps: BashOperations = {
		async exec(command, cwd, options) {
			try {
				return await containerOps!.exec(command, cwd, options);
			} catch (err) {
				if (!warnedUserBash) {
					warnedUserBash = true;
					lastUi?.notify?.(
						`Devcontainer command failed to run: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
				if (isProxyBreakError(err)) disableProxy(`devcontainer proxy failed: ${err instanceof Error ? err.message : String(err)}`);
				return { exitCode: 1 };
			}
		},
	};

	pi.on("user_bash", () => {
		if (!enabled || !containerOps) return;
		return { operations: userBashOps };
	});

	pi.on("session_start", async (_event, ctx) => {
		lastUi = ctx.ui;
		setStatus();

		if (pi.getFlag("no-devcontainer") === true) {
			enabled = false;
			ctx.ui.notify?.("Devcontainer proxying disabled via --no-devcontainer", "info");
			return;
		}
		if (alreadyInContainer()) {
			enabled = false;
			return;
		}

		const { config, path, root } = loadDevcontainerJson(ctx.cwd);
		if (!path) return; // no devcontainer in this project
		if (!config) {
			ctx.ui.notify?.(`Devcontainer file exists but could not be parsed: ${path}`, "error");
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
			ctx.ui.notify?.(
				"devcontainer.json uses build/dockerCompose and the devcontainer CLI is not installed; proxying disabled",
				"warning",
			);
			cfg = null;
			return;
		}

		const notify = (msg: string, level: "info" | "warning") => {
			if (shuttingDown) return;
			ctx.ui.notify?.(msg, level);
		};
		// Loaded once and shared by both execution modes.
		const override = loadGlobalOverride();
		// A single "what is happening now" notice: the CLI/docker bring-up
		// later reports readiness. Three toasts per session was noise.
		notify(
			useCli
				? "Starting devcontainer in the background (first run may take a while)..."
				: "Starting devcontainer container in the background (first run may pull the image)...",
			"info",
		);

		if (cfg.useCli) {
			// `devcontainer exec` does not create the container on its own —
			// it fails with "Dev container not found" until `up` has run.
			// Run `up` in the BACKGROUND: a first-run image pull can take
			// many minutes and must not block the prompt (session start).
			// The first command awaits cfg.pendingUp before it runs.
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
			// command awaits this promise. On failure the proxy is disabled
			// and pendingUp is rejected, so in-flight commands fall back to
			// the local shell.
			const c = cfg;
			c.pendingUp = (async () => {
				const up = await run("devcontainer", upArgs);
				if (up.code !== 0) {
					const detail = up.stderr.trim().split("\n").slice(0, 3).join(" ");
					disableProxy(`devcontainer up failed: ${detail || `exit ${up.code}`}`);
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
						"-lc",
						// `cd` must succeed — the exec default cwd can be a host
						// path that does not exist in the container, and bash -lc
						// does not propagate cd failures to the exit code.
						"cd \"$DEVCONTAINER_WORKSPACE_FOLDER\" 2>/dev/null && printf %s \"$PWD\"",
					]);
					if (probe.code === 0 && probe.stdout.trim()) {
						remoteWorkspace = probe.stdout.trim();
					} else {
						notify(
							`devcontainer workspace probe failed (exit ${probe.code}); commands will run from the container's default working directory (use relative paths)`,
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
				notify(`Devcontainer ready: ${c.containerName}${c.remoteWorkspace ? ` — workspace at ${c.remoteWorkspace} (host: ${c.projectCwd})` : ""}`, "info");
			})();
		} else {
			// docker fallback: bring the container up in the background (a
			// first-run image pull can take a long time and must not block
			// the prompt). The declared `workspaceFolder` is honored here
			// (the CLI cannot be pointed at it) and the mount keeps the host
			// path valid inside the container. Provisioning runs afterwards;
			// its marker lives in the container's own $HOME — which is root
			// for most images but NOT forced (see ensureDockerContainer).
			const c = cfg;
			c.workspaceFolder = declaredWorkspaceFolder;
			if (override.features && Object.keys(override.features).length > 0) {
				notify(
					"pi-override.json declares features, which only the devcontainer CLI can apply — install the CLI to get them in docker-fallback mode",
					"warning",
				);
			}
			c.pendingUp = (async () => {
				try {
					await ensureDockerContainer(c);
				} catch (err) {
					disableProxy(`docker container start failed: ${err instanceof Error ? err.message : String(err)}`);
					throw err;
				}
				if (override.provision && override.provision.length > 0) {
					await provisionContainer(notify, ["docker", "exec", c.containerName], override.provision);
				}
				notify(`Devcontainer ready: ${c.containerName} — workspace mounted at ${c.workspaceFolder} (host paths stay valid)`, "info");
			})();
		}

		// No blocking confirm here: a dialog during session start would hold
		// the prompt hostage while the container (re)starts. The status bar
		// shows the active container, and /devcontainer off (or
			// --no-devcontainer) opts out.
		let warnedOutOfMount = false;
		containerOpsFactory = () =>
			createContainerOps(
				cfg!,
				() => enabled,
				(cwd) => {
					if (warnedOutOfMount) return;
					warnedOutOfMount = true;
					notify(`Requested cwd ${cwd} is outside the mounted workspace; running from the workspace instead`, "warning");
				},
			);
		containerOps = containerOpsFactory();
		warnedUserBash = false;

		enabled = true;
		setStatus();
	});

	pi.on("session_shutdown", () => {
		// Set before disabling so an in-flight background `up` does not emit
		// notifications (or hold the process open) after the session ends.
		shuttingDown = true;
		enabled = false;
		containerOps = null;
		containerOpsFactory = null;
		cfg = null;
		setStatus();
		lastUi = null;
	});

	pi.registerCommand("devcontainer", {
		description: "Show devcontainer proxy status (also: /devcontainer on|off)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "off") {
				enabled = false;
				setStatus(ctx.ui);
				ctx.ui.notify("Devcontainer proxying disabled for this session", "info");
				return;
			}
			if (arg === "on") {
				// Re-enabling must rebuild the ops: disableProxy() nulls them,
				// and `execute` routes to the LOCAL shell when they are null
				// while the status bar claims a container.
				containerOps = containerOpsFactory?.() ?? null;
				if (!cfg || !containerOps) {
					enabled = false;
					setStatus(ctx.ui);
					ctx.ui.notify(
						cfg
							? "Devcontainer proxying could not be re-enabled (no container operations available)"
							: "No devcontainer.json found in the project directory",
						"warning",
					);
					return;
				}
				enabled = true;
				warnedUserBash = false;
				setStatus(ctx.ui);
				ctx.ui.notify(`Devcontainer proxying enabled: ${cfg.containerName}`, "info");
				return;
			}
			const lines =
				enabled && cfg && containerOps
					? [
							"Devcontainer proxy: ENABLED",
							`  Container: ${cfg.containerName}`,
							`  Mode: ${cfg.useCli ? "devcontainer CLI" : "docker"}`,
							...(cfg.image ? [`  Image: ${cfg.image}`] : []),
							...(cfg.remoteWorkspace
							? [`  Container workspace: ${cfg.remoteWorkspace} (host: ${cfg.projectCwd})`]
							: []),
							"  Commands (bash tool and !/!! user bash) run inside the container.",
						]
					: [
							"Devcontainer proxy: disabled",
							alreadyInContainer()
								? "  (pi is already running inside a container)"
								: "  No devcontainer.json found, or proxying was turned off",
							"  Use /devcontainer on to enable, or start pi without --no-devcontainer",
						];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
