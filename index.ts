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
 * inside a devcontainer: *
 * - With the `devcontainer` CLI available, commands run via
 *   `devcontainer exec --workspace-folder <project> -- bash -c '<cmd>'`.
 *   `devcontainer up` is kicked off in the BACKGROUND at session start
 *   (never blocking the prompt — a first-run image pull can take a long
 *   time); the first tool call waits for it to finish. `exec` alone does not
 *   create/attach the container (it fails with "Dev container not found"
 *   until `up` has run). If `up` fails, calls to this tool report the error
 *   rather than running anything on the host.
 * - Otherwise it falls back to plain docker, using the `image` field from
 *   devcontainer.json: it creates/starts a container
 *   `pi-devcontainer-<project>` that mounts the project at its current path
 *   and keeps it alive with `tail -f /dev/null`.
 *
 * Build-based devcontainers (no `image` field) require the devcontainer CLI;
 * without it the tool is never activated.
 *
 * A second tool, `create_devcontainer`, creates or edits the config. It does
 * not decide anything: the first call of a session reports the project's
 * stack, the available base images and the feature catalog (fetched from
 * https://containers.dev/features, once per session) and writes nothing. The
 * model then calls it again with the image and features it picked, and can
 * call it repeatedly to refine them. Edits are applied in place on top of the
 * existing config.
 *
 * Usage:
 * - `pi --no-devcontainer` - do not offer the tools for this run
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
import { createDevcontainerRenderers, OutputTail, UPDATE_THROTTLE_MS, type DevcontainerDetails } from "./render.js";
import { collectionsIn, featuresInCollection, loadCatalog, publishedVersions, searchFeatures, type CatalogFeature } from "./features-index.js";
import { asJsonObject, parseJsonc } from "./jsonc.js";
import { PortForwarder, findCliContainer } from "./ports.js";
import { BringUpLog, describePhase, startProgressWidget } from "./progress.js";
import { BASE_IMAGES, describeDockerAccess, detectStack, projectProfile, scaffold } from "./scaffold.js";
import type { DevcontainerConfig } from "./types.js";

const TOOL_NAME = "devcontainer";
const CREATE_TOOL_NAME = "create_devcontainer";
const REBUILD_TOOL_NAME = "devcontainer_rebuild";
const DEFAULT_TIMEOUT = 120;

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-devcontainer", {
		description: "Do not offer the devcontainer tool for this session",
		type: "boolean",
		default: false,
	});

	let cfg: DevcontainerConfig | null = null;
	let shuttingDown = false;
	// True from the moment bring-up starts until its promise settles. Separate
	// from bringUpFinished because that one also reads true for a session that
	// never brought anything up, and a rebuild must only refuse to stack on a
	// bring-up that is actually running.
	let bringUpInFlight = false;
	// The tool is registered unconditionally (pi requires registration before
	// setActiveTools can name it) but kept INACTIVE until the container is
	// known to be up. A project with no devcontainer, or one whose container
	// failed to start, therefore never shows a tool it cannot serve.
	let active = false;
	let lastUi: ExtensionUIContext | null = null;
	// The session's project directory, captured at session_start so the create
	// tool can act on the same directory without a second `ctx` from pi.
	let sessionCwd: string | null = null;
	// Fetched once per session on the config tool's first call.
	let catalogPromise: Promise<CatalogFeature[]> | null = null;
	// Held outside the promise so a failure can be reported per call without
	// re-awaiting an already-rejected promise on every later call.
	let catalogFailure: string | null = null;

	const notify = (msg: string, level?: "info" | "warning" | "error") => {
		if (!shuttingDown) lastUi?.notify?.(msg, level ?? "info");
	};

	// The session's forwarder, stopped at shutdown. Kept module-scoped because
	// a relay outliving the session that asked for it would keep host ports
	// bound after the user has moved on.
	let forwarder: PortForwarder | undefined;

	/**
	 * Publish container ports on the host as the container opens them, and
	 * tell the user the FROM->TO mapping each time one appears.
	 *
	 * The mapping is announced rather than merely recorded because a port you
	 * have to go looking for is a port you will not use: the point of
	 * forwarding is that the host can reach a server the developer just
	 * started inside the container, and the host port is not derivable from
	 * the container port by design (see ports.ts).
	 */
	const startPortForwarder = async (c: DevcontainerConfig, say: (message: string, level?: "info" | "warning" | "error") => void): Promise<void> => {
		// The CLI names its own container; the name this extension invents is
		// for the docker-fallback container only. Both modes are covered,
		// because neither is the other's container.
		const container = c.useCli ? await findCliContainer(c.configRoot) : c.containerName;
		if (!container) return;
		const f = new PortForwarder(container, {
			onNotice: say,
			// The tool result repeats the mapping for the model, which cannot
			// see a status-bar notice; the user's own copy comes from here.
			onPublished: () => {},
		});
		await f.noteDeclaredPorts();
		f.start();
		forwarder?.stop();
		forwarder = f;
	};

	// Changing the active tool set is transcript-visible (pi appends it before
	// the next model request), so each transition is guarded to run once and
	// never during shutdown. A session that refuses the change still works:
	// `execute` checks `active` itself and fails loudly.
	// The active tool set is a set, so the rebuild tool rides along with the
	// run tool: there is nothing to bring up until the container is up, and
	// offering a rebuild then would only report the same wait the run tool
	// reports better.
	const setToolActive = (next: boolean) => {
		if (active === next) return;
		active = next;
		if (shuttingDown) return;
		try {
			const names = pi.getActiveTools();
			pi.setActiveTools(
				next ? [...names, TOOL_NAME, REBUILD_TOOL_NAME] : names.filter((n) => n !== TOOL_NAME && n !== REBUILD_TOOL_NAME),
			);
		} catch {
			// `active` is the real gate
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
			"If this project has no devcontainer yet, create one with `create_devcontainer` first (call it with no arguments to see the available base images and features).",
			"",
			"Parameters:",
			"- `command` (required): the shell command, run with `bash -c` (non-login: profile scripts do not run).",
			"- `cwd` (optional): directory to run in, relative to the workspace root inside the container, or an absolute CONTAINER path. Omit it for the workspace root. A host path does not exist here; the result reports the host path of the directory actually used so `read`/`edit`/`write` can target the same files.",
			"- `stdin` (optional): text piped to the command's standard input. Use it for heredocs and piped input instead of shell redirection to a file.",
			"- `timeout` (optional): seconds before the command is killed (default 120). The timer starts only once the container is up, so a first-run image pull or feature build never eats the command's time budget.",
			"- `tail` (optional): keep only the LAST N lines of output, for commands whose interesting part is at the end (`npm test`, `cargo build`, a failing build). Omit it to keep the default limit. Use it when the output is mostly noise — you can always re-run with a bigger `tail` or read a log file the command wrote.",
			"- `waitForContainer` (optional): cap in seconds on the wait for a still-building container. By default the call waits until the container is up — pull/build output streams into the tool row while it waits — so a long first build does not fail the call. Pass a cap only if you want the call to come back early while the build keeps running in the background."
		].join("\n"),
		promptSnippet: "Run a shell command inside this project's devcontainer",
		promptGuidelines: [
			"`bash` runs on the host filesystem; the `devcontainer` tool runs inside the container. Build, test and dependency commands that need the container's toolchain belong in `devcontainer`; file inspection and editing belong in `read`/`edit`/`write`, which use the host path this tool reports.",
			"Container ports are published on the host on a free HIGH port, not on the container's own number, so `localhost:<container port>` is NOT the container's service — use the `container -> host` mapping this tool reports, and `curl` the host port from the `bash` tool, which runs outside the container.",
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
			timeout: Type.Optional(Type.Number({ description: "Seconds before the command is killed (default 120). The timer starts only once the container is up, so a first-run image pull or feature build never eats the command's time budget." })),
			tail: Type.Optional(
				Type.Number({
					description:
						"Keep only the last N lines of output. Use for commands whose interesting output is at the end; omit for the default limit.",
				}),
			),
			waitForContainer: Type.Optional(
				Type.Number({
					description:
						"Cap in seconds on the wait for a still-building container. Default: wait until the container is up; the build never fails the call.",
				}),
			),
		}),
		renderShell: "default",
		...createDevcontainerRenderers(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const current = cfg;
			if (!active || !current) {
				throw new Error(
					"this project has no devcontainer; create one with `create_devcontainer`, or run this command with `bash` on the host",
				);
			}
			// The output tail and the row's first update are set up BEFORE the bring-up
			// wait, because that wait is exactly the stretch where the row would
			// otherwise stay blank: a first-run image pull spends minutes there and
			// reads as a hang. The tail is seeded with the bring-up's own output, so
			// the wait shows pull progress instead of nothing.
			const tail = new OutputTail();
			const timeout = params.timeout === undefined || params.timeout <= 0 ? DEFAULT_TIMEOUT : params.timeout;
			// The emit/schedule pair is declared BEFORE the wait, not after it.
			// onProgress fires from inside ensureReady, and a const declared
			// later is in its temporal dead zone until then: a progress line
			// arriving during bring-up would throw "Cannot access 'schedule'
			// before initialization" out of the callback, which is how a
			// still-working bring-up turns into a failed tool call.
			let pending: ReturnType<typeof setTimeout> | undefined;
			let lastEmit = 0;
			let dirty = false;
			const emit = () => {
				dirty = false;
				lastEmit = Date.now();
				onUpdate?.({
					content: [{ type: "text", text: tail.value() }],
					details: tail.counts(),
				});
			};
			// Streamed on the same throttle and tail bound pi's own shell tool
			// uses, so a slow command is visibly progressing.
			const schedule = () => {
				if (!onUpdate) return;
				dirty = true;
				const delay = UPDATE_THROTTLE_MS - (Date.now() - lastEmit);
				if (delay <= 0) {
					if (pending) {
						clearTimeout(pending);
						pending = undefined;
					}
					emit();
					return;
				}
				pending ??= setTimeout(() => {
					pending = undefined;
					if (dirty) emit();
				}, delay);
			};
			await ensureReady(current, {
				isEnabled: () => active,
				onProgress: (line) => {
					tail.append(line);
					schedule();
				},
				// The user's own cancel has to stop the wait, not just the
				// command: a pull that outlives the call would otherwise keep
				// the row alive with nothing to report.
				signal,
				// The status bar is the only channel the user has during the
				// wait, since the tool row cannot render before the first tick.
				ui: ctx?.ui,
				waitBudgetSeconds: params.waitForContainer,
			});
			// The pull/build log leaves the row once the command's own output
			// starts, so the row shows the command rather than a mixture of two
			// unrelated streams.
			tail.reset();

			if (onUpdate) {
				onUpdate({
					content: [],
					details: { containerCwd: current.remoteWorkspace ?? current.projectCwd } as DevcontainerDetails,
				});
			}
			const result = await runInContainer(
				current,
				{ ...params, timeout },
				(chunk) => {
					tail.append(chunk.toString());
					schedule();
				},
				signal,
			);
			if (pending) {
				clearTimeout(pending);
				pending = undefined;
			}

			if (result.failure === "aborted") throw new Error("aborted");
			if (result.failure?.startsWith("timeout:")) {
				throw new Error(`devcontainer command timed out after ${timeout} seconds (cwd ${result.containerCwd})`);
			}

			if (params.tail !== undefined && (!Number.isFinite(params.tail) || params.tail < 1)) {
				throw new Error(`tail must be a line count of at least 1, got ${params.tail}`);
			}

			const truncated = truncateTail(result.output, params.tail === undefined ? undefined : { maxLines: params.tail });
			const forwardPorts = forwarder?.list() ?? [];
			const header = [
				`container cwd: ${result.containerCwd}`,
				`host cwd: ${result.hostCwd}`,
				`exit code: ${result.exitCode}`,
				// The mapping the model cannot derive: container ports are
				// published on a free HIGH host port, so "localhost:3000" is
				// not the container's 3000 and guessing it tests the wrong
				// process.
				...(forwardPorts.length > 0 ? [`published ports: ${forwardPorts.map((p) => `${p.containerPort} -> 127.0.0.1:${p.hostPort}`).join(", ")}`] : []),
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
				// as a failure, which only throwing achieves. `details` cannot
				// ride along on the error: the agent loop replaces a thrown tool
				// error with `{content, details:{}}`, so the output has to be
				// part of the message. The streamed updates have already shown
				// it in the TUI by this point. The same `tail` cap applies here,
				// or a failing chatty command would defeat the point of passing it.
				const shown = truncated.truncated
					? `${truncated.content}\n[output truncated: ${truncated.totalLines} lines / ${truncated.totalBytes} bytes total, showing last ${truncated.outputLines} lines]`
					: truncated.content;
				throw new Error(
					`devcontainer command exited with code ${result.exitCode} (cwd ${result.containerCwd})\n${shown}`,
				);
			}
			return {
				content: [{ type: "text", text }],
				details: {
					...tail.counts(),
					exitCode: result.exitCode,
					containerCwd: result.containerCwd,
					hostCwd: result.hostCwd,
					truncated: truncated.truncated || undefined,
				},
			};
		},
	});

	/**
	 * Detect the project's devcontainer and start bringing the container up.
	 *
	 * Extracted from the session_start handler so the create tool can re-run
	 * the whole sequence after it writes a config: config discovery happens
	 * once per call here, which is what makes scaffolding mid-session work.
	 * Bring-up itself stays in the BACKGROUND (a first-run image pull can take
	 * many minutes and must not block a tool call either), with the run
	 * tool's first call awaiting cfg.pendingUp.
	 */
	const bringUp = async (projectDir: string, extraArgs: string[] = []) => {
		cfg = null;
		bringUpInFlight = false;
		setToolActive(false);

		if (pi.getFlag("no-devcontainer") === true) return;
		const { config, path, root } = loadDevcontainerJson(projectDir);
		if (!path) return; // no devcontainer in this project
		if (!config) {
			notify(`Devcontainer file exists but could not be parsed: ${path}`, "error");
			return;
		}

		const image = typeof config.image === "string" ? config.image : undefined;
		const configRoot = root ?? projectDir;
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
		let canonicalCwd = projectDir;
		try {
			canonicalCwd = realpathSync(projectDir);
		} catch {
			// fall back to the raw cwd
		}
		cfg = {
			projectCwd: projectDir,
			canonicalCwd,
			configRoot: canonicalCwd,
			// Include a short hash of the canonical path: two projects sharing a
			// basename (e.g. ~/work/api and ~/oss/api) would otherwise collide
			// on one container name, and `ensureDockerContainer` would happily
			// `docker start` the OTHER project's container and run every
			// command against the wrong mount.
			containerName: `pi-devcontainer-${basename(projectDir)}-${createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 6)}`,
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

		// A single "what is happening now" notice; the CLI/docker bring-up
		// later reports readiness.
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
			// A first-run image pull can take many minutes, so `up` runs in
			// the BACKGROUND: the prompt must not wait for it. The first tool
			// call awaits cfg.pendingUp before it runs.
			// The CLI has no --quiet flag (0.89.0 rejects it with
			// "Unknown argument: quiet"). Output is piped away anyway.
			// The CLI bind-mounts the folder it was given and resolves the
			// config at <folder>/.devcontainer/ — it does NOT search upward —
			// so pass the canonical (symlink-resolved) host path of the
			// directory containing the config (the config root), not the
			// project cwd. A path the kernel sees differently (e.g.
			// /home/... vs /var/home/...) ends up mounted from the wrong
			// host directory, hence canonicalization.
			const wsFolder = cfg.configRoot;
			// Anything the rebuild tool was given is appended to `up` verbatim,
			// so `--no-cache` reaches the CLI without this extension having to
			// model a flag set that grows with every CLI release.
			const upArgs = ["up", "--workspace-folder", wsFolder, ...extraArgs];
			if (override.features && Object.keys(override.features).length > 0) {
				upArgs.push("--additional-features", JSON.stringify(override.features));
			}
			// exec's --workspace-folder must match the folder used for up.
			cfg.workspaceFolder = wsFolder;
			// Bring the container up in the background and resolve where the
			// workspace is mounted (e.g. /workspaces/<name>); the first
			// command awaits this promise. On failure `pendingUp` is rejected
			// and a call made in the window reports the error instead of a
			// container-less exec.
			const c = cfg;
			// The log is what the tool row, the status bar and the /devcontainer
			// command all read, so the pull it prints must be captured here. The
			// CLI writes its progress to stderr as bare-CR frames.
			const log = new BringUpLog();
			c.bringUpLog = log;
			c.pendingUp = (async () => {
				const up = await run("devcontainer", upArgs, (d) => log.append(d.toString()));
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
				notify(
					`Devcontainer ready: ${c.containerName} — the devcontainer tool runs commands with cwd ${c.remoteWorkspace ?? "(container default)"} (host: ${c.projectCwd})`,
					"info",
				);
				// Only once the container is up: relaying ports of a container
				// that is still being built reports nothing, and a poll loop
				// racing `up` would need to be told when to start.
				void startPortForwarder(c, notify);
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
			const log = new BringUpLog();
			c.bringUpLog = log;
			c.pendingUp = (async () => {
				await ensureDockerContainer(c, (d) => log.append(d.toString()));
				if (override.provision && override.provision.length > 0) {
					await provisionContainer(notify, ["docker", "exec", c.containerName], override.provision);
				}
				notify(
					`Devcontainer ready: ${c.containerName} — workspace mounted at ${c.workspaceFolder} (host paths stay valid)`,
					"info",
				);
			})();
		}

		// Offered as soon as bring-up is STARTED: the first tool call awaits
		// cfg.pendingUp (see settleBringUp), so a pending image pull blocks
		// the call rather than making the tool look unavailable.
		setToolActive(true);
		bringUpInFlight = true;

		// Both branches above assign `c.pendingUp`, and `c` is the same object
		// `cfg` points at. A session that never calls the tool would otherwise
		// surface the rejection unhandled.
		(cfg.pendingUp as Promise<void>).catch((err: unknown) => {
			bringUpFinished = true;
			// The log is included because the reason alone is rarely enough: a
			// build that dies on a feature reports `exit status 1`, and the
			// line naming the failing feature is in the output the user cannot
			// otherwise see.
			const lines = (cfg?.bringUpLog?.snapshot() ?? "").split("\n").filter(Boolean);
			const reason = err instanceof Error ? err.message : String(err);
			notify(
				`devcontainer unavailable — commands run through the devcontainer tool will fail until this is fixed: ${reason}\n${
					lines.length > 0 ? `last bring-up output (${describePhase(lines)}):\n${lines.slice(-12).join("\n")}` : "(no bring-up output was produced)"
				}`,
				"error",
			);
		// The `.catch` above resolves on failure too, so the flag after it is set
		// on both outcomes — which is what /devcontainer polls for.
		}).then(() => {
			bringUpFinished = true;
			bringUpInFlight = false;
		});

		// NOT `return cfg.pendingUp`. `bringUp` is async, so returning the
		// promise makes the CALLER's `await bringUp(...)` wait for the whole
		// bring-up — and the two callers are `session_start` (which would hold
		// pi's startup for the length of a first-run pull) and the create tool.
		// Bring-up is deliberately fire-and-forget here; the run and rebuild
		// tools are what await cfg.pendingUp, through settleBringUp's bounded
		// wait. The comment on the declaration says "returns immediately", and
		// that promise is the whole reason the tools carry a wait budget.
		void cfg.pendingUp;
	};

	/**
	 * One tool for both creating and editing a devcontainer.
	 *
	 * The first call in a session reports the project, the base images and
	 * the feature collections actually available, and writes nothing. The
	 * model then calls it again with the image and features it chose; each
	 * such call rewrites the config and restarts bring-up, so a config can be
	 * built up across several calls. The split is deliberate: an image or a
	 * feature id that does not exist is only discovered by a failed build, and a
	 * model that chose from a live catalog is far less likely to invent one.
	 *
	 * Edits read the existing config first and apply only the keys passed, so
	 * a second call with just a new feature keeps the image, name and ports
	 * already set. Each write also backs the previous version up to
	 * devcontainer.json.bak.
	 */
	const configTool = defineTool({
		name: CREATE_TOOL_NAME,
		label: "Devcontainer config",
		description: [
			"Create or edit this project's .devcontainer/devcontainer.json, choosing the base image and features yourself.",
			"",
			"Call it with NO arguments first: it reports the project's stack, the available base images, and the devcontainer feature catalog, and writes nothing. Then call it again with the `image` and `features` you picked. Each call that supplies them rewrites the file and restarts the container, so you can refine it over several calls.",
			"",
			"If a config already exists, the file is updated in place and the current contents are shown — pass keys only for what you want to change. Omitting `features` keeps the existing ones, so pass `features: {}` to clear them.",
			"",
			"Parameters:",
			"- `featureQuery` (optional): search the ~1440-feature catalog by name, e.g. \"postgres\". Returns real OCI references WITH their major tag, ready to paste. Nothing is written.",
			"- `featureCollection` (optional): list every feature in one collection, e.g. \"ghcr.io/devcontainers/features\". Nothing is written.",
			"- `featureVersions` (optional): list every PUBLISHED major version of one feature, newest first, e.g. \"ghcr.io/devcontainers/features/dotnet:2\" → shows whether :1 still exists. Only versions that actually resolve are reported. Nothing is written.",
			"- `image` (optional): base image reference.",
			"- `features` (optional): devcontainer features. The key is the full OCI reference, the value holds the feature's options DIRECTLY — `{\"ghcr.io/devcontainers/features/node:1\": {\"version\": \"22\"}}`, not `{\"options\": {...}}`.",
			"- `name` (optional): the container's display name.",
			"- `postCreateCommand` (optional): command to run once after the container is created.",
			"- `forwardPorts` (optional): host ports to forward.",
			"- `stack` (optional): force the detected stack (affects only the defaults; an explicit `image`/`features` wins).",
			"- `shareHostDocker` (optional): true (the default on Linux) shares the host's Docker daemon by bind-mounting its socket, which is what a project almost always wants. No feature is added for it. false runs a nested docker-in-docker daemon, which cannot work on a host whose Docker data root is on btrfs. An explicit docker-in-docker feature is always left as you wrote it.",
			"",
			"Example: a Node project that also needs Postgres —",
			"create_devcontainer(image: \"mcr.microsoft.com/devcontainers/typescript-node:22\", features: {\"ghcr.io/devcontainers/features/node:1\": {\"version\": \"22\"}, \"ghcr.io/devcontainers/features/postgres:1\": {\"version\": \"16\"}}, postCreateCommand: \"npm install\", forwardPorts: [5432])",
		].join("\n"),
		promptSnippet: "Create or edit this project's devcontainer config",
		promptGuidelines: [
			"Call `create_devcontainer` with no arguments first to see the project's stack, the available base images and the feature catalog, then call it again with the image and features you chose. Use `featureQuery` to search the catalog for a real feature reference. Do not guess OCI image or feature references.",
		],
		parameters: Type.Object({
			featureQuery: Type.Optional(
				Type.String({ description: "Search the feature catalog by name, e.g. \"postgres\". Returns OCI references with their major tag. Writes nothing." }),
			),
			featureCollection: Type.Optional(
				Type.String({ description: "List all features in one collection, e.g. ghcr.io/devcontainers/features. Writes nothing." }),
			),
			featureVersions: Type.Optional(
				Type.String({
					description: "List all published major versions of one feature, e.g. ghcr.io/devcontainers/features/dotnet:2. Writes nothing.",
				}),
			),
			image: Type.Optional(Type.String({ description: "Base image, e.g. mcr.microsoft.com/devcontainers/base:ubuntu" })),
			features: Type.Optional(
				Type.Record(Type.String(), Type.Object({}, { additionalProperties: true }), {
					description: 'Features: keys are "<collection>/<feature>:<major>", values hold the options directly, e.g. {"ghcr.io/devcontainers/features/node:1": {"version": "22"}}. Omit to keep the existing ones, pass {} to clear them.',
				}),
			),
			name: Type.Optional(Type.String({ description: "Container display name" })),
			postCreateCommand: Type.Optional(Type.String({ description: "Command run once after the container is created" })),
			forwardPorts: Type.Optional(Type.Array(Type.Union([Type.Number(), Type.String()]))),
			stack: Type.Optional(Type.String({ description: "Force the detected stack instead of using detection" })),
		shareHostDocker: Type.Optional(
			Type.Boolean({
				description: "Share the host's Docker daemon by bind-mounting its socket (default true on Linux/other); no feature is written for it. Set false for a nested docker-in-docker daemon — that one fails on a host whose Docker data root is on btrfs. An explicit docker-in-docker feature in `features` is never rewritten.",
			}),
		),
		}),
		renderShell: "default",
		async execute(_toolCallId, params, signal) {
			if (!sessionCwd) throw new Error("no project directory for this session");
			const projectRoot = sessionCwd;
			const target = join(projectRoot, ".devcontainer", "devcontainer.json");
			const bare = join(projectRoot, "devcontainer.json");
			const existingPath = existsSync(target) ? target : existsSync(bare) ? bare : undefined;

			// The catalog is fetched on the FIRST call of the session and reused
			// afterwards: a config is normally built over a few calls, and
			// re-fetching 1440 features for each one would be wasteful.
			if (!catalogPromise) catalogPromise = loadCatalog().then((r) => r.features);
			let catalog: CatalogFeature[] | null;
			try {
				catalog = await catalogPromise;
			} catch (err) {
				// A lookup failure must not block writing a config: the model
				// may already know what it wants.
				catalog = null;
				catalogFailure = err instanceof Error ? err.message : String(err);
			}

			// No arguments: report and change nothing.
			const wantsWrite = params.image !== undefined || params.features !== undefined || params.name !== undefined || params.postCreateCommand !== undefined || params.forwardPorts !== undefined || params.stack !== undefined || params.shareHostDocker !== undefined;
			const profile = projectProfile(projectRoot);

			// A targeted lookup: the model already knows what it wants, so skip
			// the survey and answer the question directly.
			if (params.featureVersions) {
				const { ref, versions } = await publishedVersions(params.featureVersions);
				const text =
					versions.length === 0
						? `${ref} has no published major version (the feature does not exist, or nothing behind it resolves).`
						: [
								`published major versions of ${ref}, newest first:`,
								...versions.map((v) => `  ${ref}:${v.tag}  (feature version ${v.version})`),
								"",
								"Use the one matching what the project needs; a higher major is not automatically the right choice.",
							].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { mode: "versions", featureVersions: params.featureVersions } as Record<string, unknown>,
				};
			}
			if (params.featureQuery || params.featureCollection) {
				const text = params.featureCollection
					? (await featuresInCollection(params.featureCollection)).text
					: (await searchFeatures(params.featureQuery ?? "")).text;
				return {
					content: [{ type: "text", text }],
					details: { mode: "lookup", featureQuery: params.featureQuery, featureCollection: params.featureCollection } as Record<string, unknown>,
				};
			}

			if (!wantsWrite) {
				const text = [
					`project: ${projectRoot}`,
					`detected stack: ${profile.stack}${profile.markers.length > 0 ? ` (markers: ${profile.markers.join(", ")})` : " (no marker files in the project root)"}`,
					`suggested for this stack: image ${profile.suggestedImage}${profile.suggestedFeature ? `, feature ${profile.suggestedFeature}:1` : ""}`,
					`other stacks you can force: ${profile.stackOptions.join(", ")}`,
					existingPath ? `existing config: ${existingPath}` : "no config yet",
					"",
					"base images:",
					...BASE_IMAGES.map((b) => `  ${b.image}  — ${b.for}`),
					"",
					...(catalog
						? [
							"",
							`feature collections (${collectionsIn(catalog).size} collections, ${catalog.length} features in the catalog):`,
							[...collectionsIn(catalog).entries()]
								.sort((a, b) => b[1] - a[1])
								.slice(0, 25)
								.map(([c, n]) => `  ${c}  (${n})`)
								.join("\n"),
							"",
							"features in the reference collection:",
							catalog
								.filter((f) => f.ref.startsWith("ghcr.io/devcontainers/features/"))
								.map((f) => `  ${f.ref}  ${f.name}`)
								.join("\n"),
							"",
							"Call again with `featureQuery` (e.g. \"postgres\") to search the whole catalog, `featureCollection` to list one collection, or `featureVersions` to see which majors of a feature exist.",
						]
						: ["", `feature catalog unavailable: ${catalogFailure}. Pass an image and features you already know, or retry later.`]),
					existingPath
						? "Call again with the `image`/`features` you want to change."
						: "Call again with the `image` and `features` you want.",
				].join("\n");
				return { content: [{ type: "text", text }], details: { mode: "inspect", stack: profile.stack, image: profile.suggestedImage, path: existingPath } as Record<string, unknown> };
			}

			// Writing. An existing config is the base so an edit changes only
			// the keys passed: the model is iterating, not replacing.
			let base: Record<string, unknown> = {};
			if (existingPath) {
				try {
					base = asJsonObject(parseJsonc(readFileSync(existingPath, "utf-8"))) ?? {};
				} catch (err) {
					throw new Error(`${existingPath} could not be parsed, refusing to overwrite it: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const stack = params.stack && !profile.stackOptions.includes(params.stack)
				? undefined
				: params.stack;
			if (params.stack && stack === undefined) {
				throw new Error(`unknown stack "${params.stack}"; expected one of: ${profile.stackOptions.join(", ")}`);
			}
			const detected = detectStack(projectRoot);
			const effectiveStack = stack ?? detected.id;
			// dind is never rewritten: a config that nests its daemon is
			// isolating itself from the host's containers on purpose. It is
			// only reported, with the btrfs failure mode, so the model can
			// decide whether the config or the host is what needs changing.
			const dockerAccess = describeDockerAccess(base);
			const defaults = scaffold({
				projectRoot,
				stack: effectiveStack,
				image: params.image,
				features: params.features as Record<string, Record<string, unknown>> | undefined,
				postCreateCommand: params.postCreateCommand,
				forwardPorts: params.forwardPorts as (number | string)[] | undefined,
				shareHostDocker: params.shareHostDocker,
			});
			const config: Record<string, unknown> = {
				...base,
				...defaults.config,
				...(params.name ? { name: params.name } : {}),
			};
			// The base's own features survive an edit that does not mention
			// any, which is the point of an in-place edit.
			if (params.features === undefined && base.features) config.features = base.features;

			if (existingPath) copyFileSync(existingPath, `${existingPath}.bak`);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);

			// Re-run detection so the run tool is offered for the project that
			// now has a config. Bring-up is a background promise awaited by the
			// first `devcontainer` call, so this returns immediately.
			await bringUp(projectRoot);
			if (signal?.aborted) throw new Error("aborted");
			notify(`Updated ${target} — restarting the devcontainer in the background`, "info");

			return {
				content: [
					{
						type: "text",
						text: [
							`${existingPath ? "updated" : "wrote"}: ${target}`,
							`stack: ${effectiveStack}${stack ? " (forced)" : existingPath ? " (detected; existing config preserved)" : " (detected)"}`,
							`image: ${String(config.image)}`,
							`features: ${Object.keys((config.features as Record<string, unknown>) ?? {}).join(", ") || "(none)"}`,
							// A silent repair would leave the model explaining a
							// config change it never made, so the finding is stated
							// in the result.
							...(dockerAccess.mode === "dind" ? [`docker: ${dockerAccess.note}`] : []),
							"",
							JSON.stringify(config, null, 2),
						].join("\n"),
					},
				],
				details: { mode: "write", path: target, stack: effectiveStack, image: String(config.image ?? "") } as Record<string, unknown>,
			};
		},
	});

	/**
	 * Rebuild the image from the config as it stands now.
	 *
	 * The escape hatch for an edit the bring-up did not pick up: a Dockerfile
	 * or compose file the config references, a feature the author pinned by
	 * hand, or a layer the CLI cached that is now wrong. A rebuild is `devcontainer
	 * up` again from a clean slate, so the argument is passed straight through
	 * rather than modelled — `--no-cache` and a future flag both work without a
	 * change here.
	 */
	const rebuildTool = defineTool({
		name: REBUILD_TOOL_NAME,
		label: "Rebuild devcontainer",
		description: [
			"Rebuild this project's devcontainer image from its current config.",
			"",
			"Use this after editing anything the image is built from — devcontainer.json, a `dockerFile`, a compose file — when you need the container to actually pick the change up. It re-runs `devcontainer up` in the BACKGROUND, exactly as the session start does, so it can take as long as a first-run pull; the progress streams into this tool row and the devcontainer tool activates again when the container is up.",
			"",
			"A rebuild while one is already running is refused rather than stacked, because two `up` processes against one container would report each other's failures.",
			"",
			"Parameters:",
			"- `extraArgs` (optional): arguments appended to `devcontainer up` verbatim, e.g. \"--no-cache\" or \"--remove-existing-container\". Omit it for a normal rebuild. Anything invalid is rejected by the CLI, with its own message.",
			"- `waitForContainer` (optional): cap in seconds on the wait for the rebuild to finish. By default the call waits until the rebuild is done — pull/build output streams into the tool row while it waits. Pass a cap only if you want the call to come back early while the rebuild keeps running in the background."
		].join("\n"),
		promptSnippet: "Rebuild this project's devcontainer image from its config",
		promptGuidelines: [
			"After editing `.devcontainer/devcontainer.json`, a `dockerFile` or a compose file, call `devcontainer_rebuild` so the running container matches the change.",
		],
		parameters: Type.Object({
			extraArgs: Type.Optional(
				Type.String({
					description: 'Arguments appended to `devcontainer up` verbatim, e.g. "--no-cache". Omit for a normal rebuild.',
				}),
			),
			waitForContainer: Type.Optional(
				Type.Number({
					description: "Cap in seconds on the wait for the rebuild. Default: wait until the rebuild is done.",
				}),
			),
		}),
		renderShell: "default",
		...createDevcontainerRenderers(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const projectDir = sessionCwd;
			if (!projectDir) throw new Error("no session directory to rebuild; this tool only works inside a project session");
			const { path } = loadDevcontainerJson(projectDir);
			if (!path) {
				throw new Error(
					`no .devcontainer/devcontainer.json in ${projectDir}; create one with \`${CREATE_TOOL_NAME}\` first — there is nothing to rebuild`,
				);
			}
			if (bringUpInFlight) {
				throw new Error(
					"a devcontainer bring-up is already running for this project; a second `up` would race it for the same container. Wait for it to finish — call this again once the devcontainer tool reports the container is up.",
				);
			}
			// Split on whitespace rather than shell-parsing: these become
			// separate argv entries, so a quote in the text has nothing to
			// escape into and cannot smuggle an extra argument.
			const extraArgs = (params.extraArgs ?? "").trim() ? (params.extraArgs as string).trim().split(/\s+/) : [];

			// The row is created and its first update emitted BEFORE the wait, and
			// the throttle handle is declared before it too — onProgress fires from
			// inside ensureReady, and a `const` declared later is in its temporal
			// dead zone until then, which would throw out of the callback.
			const tail = new OutputTail();
			let pending: ReturnType<typeof setTimeout> | undefined;
			let lastEmit = 0;
			let dirty = false;
			const emit = () => {
				if (!onUpdate) return;
				lastEmit = Date.now();
				dirty = false;
				onUpdate({ content: [{ type: "text", text: tail.value() }], details: tail.counts() });
			};
			const schedule = () => {
				if (!onUpdate) return;
				dirty = true;
				const delay = Math.max(0, UPDATE_THROTTLE_MS - (Date.now() - lastEmit));
				if (delay <= 0) {
					if (pending) {
						clearTimeout(pending);
						pending = undefined;
					}
					emit();
					return;
				}
				if (pending) return;
				pending = setTimeout(() => {
					pending = undefined;
					if (dirty) emit();
				}, delay);
			};
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `rebuilding from ${path}${extraArgs.length > 0 ? ` (${extraArgs.join(" ")})` : ""}…\n` }],
					details: tail.counts(),
				});
			}
			await bringUp(projectDir, extraArgs);
			await ensureReady(cfg as DevcontainerConfig, {
				isEnabled: () => active,
				onProgress: (line) => {
					tail.append(line);
					schedule();
				},
				signal,
				ui: ctx?.ui,
				waitBudgetSeconds: params.waitForContainer,
			});
			// The pull log leaves the row once the rebuild itself is done.
			tail.reset();
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `rebuilt from ${path}${extraArgs.length > 0 ? ` (${extraArgs.join(" ")})` : ""}\n` }],
					details: tail.counts(),
				});
			}
			const ready = cfg;
			return {
				content: [
					{
						type: "text",
						text: [
							`rebuilt: ${path}`,
							`container: ${ready?.containerName ?? "(unknown)"}`,
							`workspace: ${ready?.remoteWorkspace ?? ready?.workspaceFolder ?? "(container default)"}`,
							"",
							`Run commands in it with the \`${TOOL_NAME}\` tool.`,
						].join("\n"),
					},
				],
				details: { mode: "rebuild", path, extraArgs } as Record<string, unknown>,
			};
		},
	});

	pi.registerTool(devcontainerTool);
	pi.registerTool(rebuildTool);
	pi.registerTool(configTool);

	// The bring-up log, for the slash command. Kept in the same module scope
	// as `cfg` so the command shows the SAME lines the tool row does rather
	// than starting a second `up` that would race the first.
	//
	// `cfg.pendingUp` is never cleared, so it cannot say whether the bring-up
	// is still running; a session flag set from the same handlers that report
	// the outcome is the honest signal, and polling the promise itself would
	// spin for the life of the session.
	let bringUpFinished = false;
	const liveLog = (): BringUpLog => cfg?.bringUpLog ?? new BringUpLog();
	const watchUi = (ui: ExtensionUIContext | null | undefined): void => {
		const log = cfg?.bringUpLog;
		const lines = log ? log.snapshot().split("\n").filter(Boolean) : [];
		if (!cfg) {
			ui?.notify?.("no devcontainer is being built for this project", "warning");
			return;
		}
		if (lines.length === 0) {
			// A one-shot status would be a lie here: nothing has printed yet, so
			// the widget is what the user watches until output arrives.
			ui?.setStatus?.("devcontainer", "⏳ devcontainer — waiting for the first output…");
			const stop = startProgressWidget(ui ?? undefined, liveLog(), cfg.projectCwd);
			setTimeout(stop, 1500);
			return;
		}
		// The phase is the part the user cannot read off a raw log line, so
		// it is stated first; the tail of the log is what they asked for.
		ui?.notify?.(`devcontainer: ${describePhase(lines)} — ${cfg.projectCwd}\n${lines.slice(-12).join("\n")}`, "info");
	};

	pi.registerCommand("devcontainer", {
		description: "show what the devcontainer bring-up is doing right now",
		handler: async (_args, cmdCtx) => {
			const ui = cmdCtx?.ui ?? lastUi;
			if (ui?.setStatus) {
				// A long poll rather than a one-shot: the user asked to WATCH,
				// and the log is produced by a background process that may not
				// have printed yet.
				ui.setStatus("devcontainer", "⏳ devcontainer — watching bring-up, press esc to stop");
				const stop = startProgressWidget(ui, liveLog(), cfg?.projectCwd ?? "this project");
				const timer = setInterval(() => {
					if (!bringUpFinished) return;
					clearInterval(timer);
					stop();
					ui.notify?.("devcontainer bring-up finished", "info");
				}, 1000);
				timer.unref?.();
			} else {
				watchUi(ui);
			}
		},
	});

	pi.registerCommand("devcontainer-ports", {
		description: "list the container ports pi has published on the host",
		handler: async (_args, cmdCtx) => {
			const ui = cmdCtx?.ui ?? lastUi;
			const list = forwarder?.list() ?? [];
			ui?.notify?.(
				list.length > 0
					? list.map((p) => `devcontainer: container ${p.containerPort} -> host 127.0.0.1:${p.hostPort}`).join("\n")
					: "devcontainer: no container ports are published on the host yet — start a server in the container and they appear here",
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		lastUi = ctx.ui;
		sessionCwd = ctx.cwd;
		// Registered but not offered: pi records the tool set in the
		// transcript's first system message, so leaving it active in a project
		// with no devcontainer would advertise a command the model cannot use.
		// Done before any await so it lands before the prompt is built.
		setToolActive(false);

		if (alreadyInContainer()) return;
		await bringUp(ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		// Set before clearing so an in-flight background `up` does not emit
		// notifications (or hold the process open) after the session ends.
		shuttingDown = true;
		active = false;
		// Host ports bound by a relay outlive the session that asked for them,
		// so the forwarder is stopped here rather than left to its unref'd
		// timer, which would keep publishing until the next process ends.
		forwarder?.stop();
		forwarder = undefined;
		cfg = null;
		lastUi = null;
		sessionCwd = null;
	});
}
