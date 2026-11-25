/**
 * Which container CLI runs the devcontainer, and what that CLI can do.
 *
 * Docker and Podman answer the same inspect/run/exec commands, but they do
 * NOT agree on everything this extension relies on:
 *
 * - Port reachability. A Docker bridge container has its own address on the
 *   host's network, so a port it opens after start can be relayed to. A
 *   ROOTLESS Podman container shares the host's network identity through
 *   pasta: nothing the host does can open a connection into it, so only ports
 *   published when the container was created are reachable.
 * - A shared daemon socket lives somewhere else. Docker is
 *   /var/run/docker.sock; rootless Podman keeps it under $XDG_RUNTIME_DIR.
 * - Compose is a separate binary (podman-compose) that the devcontainer CLI
 *   has to be told about.
 *
 * Everything engine-specific is decided here once and then carried in a
 * ContainerEngine, so the rest of the extension never branches on a binary
 * name. The CLI itself is selected with `--docker-path`, which is the
 * devcontainer CLI's own name for "the container CLI to use" — Podman is
 * driven through its Docker-compatible command surface, not through a
 * separate code path.
 */

import { basename } from "node:path";

import { run } from "./exec.js";

/**
 * Env var that picks the CLI. `docker` or `podman` selects that binary by
 * name, `auto` (the default) asks each in turn, and anything with a path in
 * it is run as written (so a wrapper script or a nerdctl-style alias works
 * too, named after whatever it talks to).
 */
export const ENGINE_ENV = "PI_DEVCONTAINER_ENGINE";

export type EngineKind = "docker" | "podman";

export interface ContainerEngine {
	/** Which family the CLI speaks. */
	kind: EngineKind;
	/** The binary spawned for inspect/run/exec, and handed to `--docker-path`. */
	cli: string;
	/** `--version` output, when the binary answered. */
	version?: string;
	/**
	 * Rootless Podman: containers have no host-routable address of their own.
	 * Always false for Docker.
	 */
	rootless: boolean;
	/**
	 * How the host reaches a port the CONTAINER opens after it started.
	 *
	 * "container-ip": relay through the container's own address.
	 * "published-only": only ports published at create time are reachable, so
	 * the port forwarder can report them but must not relay anything new.
	 */
	portRouting: "container-ip" | "published-only";
	/** Host-side daemon socket to bind-mount when a config shares Docker access. */
	socketPath: string;
	/** Compose CLI the devcontainer CLI must use, when it is not the docker default. */
	composeCli?: string;
	/** Where this choice came from, for the notices that explain it. */
	source: "env" | "detected" | "fallback";
	/** Set when NOTHING usable answered; bring-up cannot work until this is fixed. */
	problem?: string;
}

/** One bounded probe: never throws, because a missing binary is an answer. */
async function probe(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const r = await run(cmd, args, undefined, 15);
		return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
	} catch (err) {
		return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
}

function firstLine(value: string): string | undefined {
	const line = value.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
	return line || undefined;
}

/**
 * The env var's value, or undefined for "decide for me". A blank value and
 * `auto` mean the same thing, so an exported-but-empty variable cannot make
 * the extension unusable by accident.
 */
export function parseEngineSetting(value: string | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	if (trimmed === "" || trimmed.toLowerCase() === "auto") return undefined;
	return trimmed;
}

/** The host socket Docker itself defaults to, honoring a unix DOCKER_HOST. */
function dockerSocketPath(env: NodeJS.ProcessEnv): string {
	const host = (env.DOCKER_HOST ?? "").trim();
	if (host.startsWith("unix://") && host.length > "unix://".length) return host.slice("unix://".length);
	return "/var/run/docker.sock";
}

/**
 * Podman's API socket. Rootless puts it in the user's runtime directory
 * (where the socket service started at login keeps it), rootful in /run.
 */
function podmanSocketPath(rootless: boolean, env: NodeJS.ProcessEnv): string {
	if (!rootless) return "/run/podman/podman.sock";
	const runtime = (env.XDG_RUNTIME_DIR ?? "").trim() || `/run/user/${process.getuid?.() ?? 1000}`;
	return `${runtime}/podman/podman.sock`;
}

async function describeDocker(cli: string, source: ContainerEngine["source"], env: NodeJS.ProcessEnv): Promise<ContainerEngine> {
	const version = await probe(cli, ["--version"]);
	return {
		kind: "docker",
		cli,
		...(firstLine(version.stdout) ? { version: firstLine(version.stdout) } : {}),
		rootless: false,
		portRouting: "container-ip",
		socketPath: dockerSocketPath(env),
		source,
	};
}

async function describePodman(cli: string, source: ContainerEngine["source"], env: NodeJS.ProcessEnv): Promise<ContainerEngine> {
	const [version, info, compose] = await Promise.all([
		probe(cli, ["--version"]),
		probe(cli, ["info", "--format", "{{.Host.Security.Rootless}}"]),
		probe("podman-compose", ["--version"]),
	]);
	// `podman info` is the only reliable statement of rootless-ness; when it
	// does not answer, assume rootless is FALSE and let the port relay fail
	// visibly rather than silently disabling a working setup.
	const rootless = info.ok && info.stdout.trim() === "true";
	return {
		kind: "podman",
		cli,
		...(firstLine(version.stdout) ? { version: firstLine(version.stdout) } : {}),
		rootless,
		// A rootless Podman container is reachable only through published
		// ports; a rootful one sits on a bridge with a routable address and
		// behaves like Docker.
		portRouting: rootless ? "published-only" : "container-ip",
		socketPath: podmanSocketPath(rootless, env),
		...(compose.ok ? { composeCli: "podman-compose" } : {}),
		source,
	};
}

/** Does this CLI answer `info` at all? The question is liveness, not version. */
async function dockerAnswers(): Promise<boolean> {
	// `docker info` talks to the DAEMON, which is exactly what has to be
	// there; `docker --version` would happily report a client with nothing
	// behind it (the common "daemon not running" machine).
	return (await probe("docker", ["info", "--format", "{{.ServerVersion}}"])).ok;
}

async function podmanAnswers(): Promise<boolean> {
	return (await probe("podman", ["info", "--format", "{{.Host.Security.Rootless}}"])).ok;
}

async function detect(env: NodeJS.ProcessEnv): Promise<ContainerEngine> {
	const explicit = parseEngineSetting(env[ENGINE_ENV]);
	if (explicit) {
		// A configured engine is used as written: a typo must fail loudly
		// rather than quietly fall back to the other family.
		const kind: EngineKind = /podman/i.test(basename(explicit)) ? "podman" : "docker";
		const engine =
			kind === "podman" ? await describePodman(explicit, "env", env) : await describeDocker(explicit, "env", env);
		if (!engine.version) {
			engine.problem = `${ENGINE_ENV}=${explicit} does not run as a container CLI (${kind})`;
		}
		return engine;
	}
	if (await dockerAnswers()) return describeDocker("docker", "detected", env);
	if (await podmanAnswers()) return describePodman("podman", "detected", env);
	// Neither answered. Docker is reported so the failure keeps the wording
	// the user's own `docker` command would produce, plus the reason.
	const engine = await describeDocker("docker", "fallback", env);
	engine.problem =
		"no container engine answered: `docker info` failed (is the Docker daemon running?) and `podman info` was not usable either. Start Docker, start Podman, or set " +
		`${ENGINE_ENV}=podman`;
	return engine;
}

// Resolution is per PROCESS and cached: bring-up, every exec, the port
// forwarder and the create tool all ask the same question, and probing each
// time would spawn several processes per tool call. The cache key includes
// PATH because that is what a spawn resolves against — tests and wrapper
// scripts flip it, and a stale engine would then point at a binary that is no
// longer there.
let cached: Promise<ContainerEngine> | undefined;
let cachedKey: string | undefined;

/** Forget the cached resolution (tests, and a caller that changed the environment). */
export function resetEngineCache(): void {
	cached = undefined;
	cachedKey = undefined;
	cliArgsCache = undefined;
}

/** The engine this session uses, resolved once. */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): Promise<ContainerEngine> {
	const key = [env[ENGINE_ENV] ?? "", env.DOCKER_HOST ?? "", env.XDG_RUNTIME_DIR ?? "", env.PATH ?? ""].join("\u0000");
	if (!cached || cachedKey !== key) {
		cachedKey = key;
		cached = detect(env);
	}
	return cached;
}

/**
 * One-line description for notices and tool output, e.g.
 * `podman version 6.1.3, rootless` or `Docker version 29.10.0`.
 */
export function engineSummary(engine: ContainerEngine): string {
	// `--version` output ends in build metadata ("Docker version 29.10.0, build
	// abc"); it says nothing about this session and only makes the notice long.
	const label = (engine.version ?? engine.cli).replace(/,\s*build\b.*$/i, "");
	if (engine.kind !== "podman") return label;
	return `${label}, ${engine.rootless ? "rootless" : "rootful"}`;
}

/**
 * Whether the installed devcontainer CLI knows the flags Podman needs.
 * Probed from `up --help` because the flag set is the CLI's, not ours: an
 * older CLI fails with "Unknown argument" and the message that follows from
 * that is far less useful than this answer.
 */
let helpCache: Promise<{ dockerPath: boolean; composePath: boolean }> | undefined;

async function devcontainerCliFlags(): Promise<{ dockerPath: boolean; composePath: boolean }> {
	helpCache ??= (async () => {
		const help = await probe("devcontainer", ["up", "--help"]);
		const text = `${help.stdout}\n${help.stderr}`;
		return { dockerPath: text.includes("--docker-path"), composePath: text.includes("--docker-compose-path") };
	})();
	return helpCache;
}

// Keyed by the CLI it was computed for, for the same reason the engine is:
// the arguments are the whole of the engine's effect on the devcontainer CLI.
let cliArgsCache: { key: string; value: Promise<string[]> } | undefined;

/**
 * Arguments that make the devcontainer CLI drive THIS engine.
 *
 * Empty for the plain Docker default: the CLI's own default is already
 * `docker`, and passing a flag it may not know would break old CLIs for no
 * gain. A named or non-default CLI has to be passed, so a CLI too old to
 * accept the flag is an error rather than a silent Docker bring-up.
 */
export async function engineCliArgs(engine: ContainerEngine): Promise<string[]> {
	const key = `${engine.cli}\u0000${engine.composeCli ?? ""}`;
	if (cliArgsCache?.key === key) return cliArgsCache.value;
	const value = (async () => {
		const plainDocker = engine.kind === "docker" && engine.cli === "docker" && !engine.composeCli;
		if (plainDocker) return [];
		const flags = await devcontainerCliFlags();
		if (!flags.dockerPath) {
			throw new Error(
				`the installed devcontainer CLI does not accept --docker-path, which is the only way to run it against ${engine.kind}; upgrade it (npm install -g @devcontainers/cli@latest) or put \`${engine.cli}\` on PATH as \`docker\``,
			);
		}
		const args = ["--docker-path", engine.cli];
		if (engine.composeCli) {
			if (!flags.composePath) {
				throw new Error(
					`the installed devcontainer CLI does not accept --docker-compose-path, needed to use ${engine.composeCli} with ${engine.cli}; upgrade it (npm install -g @devcontainers/cli@latest)`,
				);
			}
			args.push("--docker-compose-path", engine.composeCli);
		}
		return args;
	})();
	cliArgsCache = { key, value };
	return value;
}
