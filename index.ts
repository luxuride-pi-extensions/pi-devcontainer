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
 * A second tool, `create_devcontainer`, creates or edits the config. It does
 * not decide anything: the first call of a session reports the project's
 * stack, the available base images and the feature collections (fetched from
 * the published collection index, once per session) and writes nothing. The
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
import { collectionsIn, featuresInCollection, loadCatalog, publishedVersions, searchFeatures, type CatalogFeature } from "./features-index.js";
import { asJsonObject, parseJsonc } from "./jsonc.js";
import { BASE_IMAGES, detectStack, projectProfile, scaffold } from "./scaffold.js";
import type { DevcontainerConfig } from "./types.js";

const TOOL_NAME = "devcontainer";
const CREATE_TOOL_NAME = "create_devcontainer";
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
	// The session's project directory, captured at session_start so the create
	// tool can act on the same directory without a second `ctx` from pi.
	let sessionCwd: string | null = null;
	// Fetched once per session on the config tool's first call.
	let catalogPromise: Promise<CatalogFeature[]> | null = null;
	// Held out of the promise so a failure can be reported per call without
	// re-awaiting an already-rejected promise on every later call.
	let catalogFailure: string | null = null;

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
			"If this project has no devcontainer yet, create one with `create_devcontainer` first (call it with no arguments to see the available base images and features).",
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
					"this project has no devcontainer; create one with `create_devcontainer`, or run this command with `bash` on the host",
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
	const bringUp = async (projectDir: string) => {
		cfg = null;
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
				notify(
					`Devcontainer ready: ${c.containerName} — workspace mounted at ${c.workspaceFolder} (host paths stay valid)`,
					"info",
				);
			})();
		}

		// Offered as soon as bring-up is STARTED, not when it finishes: the
		// first tool call awaits cfg.pendingUp (see settleBringUp), so a
		// pending image pull blocks the call rather than making the tool look
		// unavailable. Withholding it until ready would make a freshly
		// scaffolded project report "use bash on the host instead" for the
		// whole pull, which is the exact confusion this extension exists to
		// avoid.
		setToolActive(true);

		// Bring-up failures are reported here rather than left as an unhandled
		// rejection: the background promise is awaited by the first tool call,
		// but a session that never calls the tool would otherwise surface a
		// raw rejection instead of the actionable message.
		// SAFETY: both branches above assign `c.pendingUp`, and `c` is the
		// same object `cfg` points at. The assertion documents that the
		// catch below is watching the promise both of them created.
		(cfg.pendingUp as Promise<void>).catch((err: unknown) => {
			notify(
				`devcontainer unavailable — commands run through the devcontainer tool will fail until this is fixed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		});
	};

	/**
	 * One tool for both creating and editing a devcontainer.
	 *
	 * The first call in a session reports the project, the base images and
	 * the feature collections actually available, and writes nothing. The
	 * model then calls it again with the image and features it chose; each
	 * such call rewrites the config and restarts bring-up, so a config can be
	 * built up across several calls instead of being committed to in one
	 * guess. That split is deliberate: an image or a feature id that does not
	 * exist is only discovered by a failed build, and a model that chose from
	 * a live catalog is far less likely to invent one.
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
			const wantsWrite = params.image !== undefined || params.features !== undefined || params.name !== undefined || params.postCreateCommand !== undefined || params.forwardPorts !== undefined || params.stack !== undefined;
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
			const defaults = scaffold({
				projectRoot,
				stack: effectiveStack,
				features: params.features as Record<string, Record<string, unknown>> | undefined,
				postCreateCommand: params.postCreateCommand,
				forwardPorts: params.forwardPorts as (number | string)[] | undefined,
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
							"",
							JSON.stringify(config, null, 2),
						].join("\n"),
					},
				],
				details: { mode: "write", path: target, stack: effectiveStack, image: String(config.image ?? "") } as Record<string, unknown>,
			};
		},
	});

	pi.registerTool(devcontainerTool);
	pi.registerTool(configTool);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		lastUi = ctx.ui;
		sessionCwd = ctx.cwd;
		// Registered but not offered: pi records the tool set in the
		// transcript's first system message, so leaving it active in a project
		// with no devcontainer would advertise a command the model cannot use.
		// Done at the very start of session_start, before any await, so it
		// lands before the prompt is built.
		setToolActive(false);

		if (alreadyInContainer()) return;
		await bringUp(ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		// Set before clearing so an in-flight background `up` does not emit
		// notifications (or hold the process open) after the session ends.
		shuttingDown = true;
		active = false;
		cfg = null;
		lastUi = null;
		sessionCwd = null;
	});
}
