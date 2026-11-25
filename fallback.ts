import type { ContainerEngine } from "./engine.js";
import { resolveEngine } from "./engine.js";
import type { DevcontainerConfig } from "./types.js";
import { run } from "./exec.js";

/**
 * Publish flags for the config's `appPort` entries.
 *
 * Only used when the engine cannot be reached through the container's own
 * address (rootless Podman — see engine.ts): there, a port the container
 * opens after start is unreachable from the host no matter what this
 * extension does, so the ports the config DECLARES are the only ones worth
 * having and they have to be published at create time.
 *
 * Everything is bound to 127.0.0.1 unless the entry names its own address:
 * publishing a dev server on every interface is a decision the user should
 * make explicitly.
 */
export function publishArgs(appPort: unknown): string[] {
	const args: string[] = [];
	for (const entry of Array.isArray(appPort) ? appPort : []) {
		if (typeof entry === "number") {
			if (!Number.isInteger(entry) || entry <= 0 || entry > 65535) continue;
			// Port only: let the engine pick the host port, as it does for `-p`.
			args.push("-p", `127.0.0.1::${entry}`);
			continue;
		}
		if (typeof entry !== "string") continue;
		const spec = entry.trim();
		if (spec === "") continue;
		const parts = spec.split(":");
		if (parts.length >= 3) {
			// An address of its own was given; take it as written.
			args.push("-p", spec);
		} else if (parts.length === 2 && /^\d+$/.test(parts[0] ?? "")) {
			args.push("-p", `127.0.0.1:${spec}`);
		} else {
			args.push("-p", `127.0.0.1::${spec}`);
		}
	}
	return args;
}

/**
 * Create or start the container the extension runs when `devcontainer up` is
 * not available: an image-only config, kept alive by `tail -f /dev/null`.
 *
 * The container is named by the caller (see DevcontainerConfig.containerName,
 * which hashes the project path): a second project with the same basename
 * must not adopt the first one's container and its mount.
 */
export async function ensureFallbackContainer(
	cfg: DevcontainerConfig,
	onData?: (data: Buffer) => void,
	engine?: ContainerEngine,
): Promise<void> {
	const eng = engine ?? (await resolveEngine());
	const name = cfg.containerName;
	if (!cfg.image) {
		throw new Error(
			`devcontainer.json has no "image" field and the devcontainer CLI is not available; cannot run the container with ${eng.cli} alone`,
		);
	}
	const inspect = await run(eng.cli, ["inspect", "-f", "{{.State.Status}}", name]);
	if (inspect.code === 0) {
		if (inspect.stdout.trim() === "running") return;
		await run(eng.cli, ["start", name], onData, 0);
		return;
	}
	// Container does not exist - create it, mounting the config root
	// (the directory containing devcontainer.json, which may be a
	// parent of the project — the mount then includes the project as
	// a subdirectory) at its host path.
	//
	// Mount the declared workspace folder at the SAME host path, so host
	// absolute paths keep working inside the container (unlike CLI mode,
	// which virtualizes the mount point). A container created by an earlier
	// run keeps its original mount until it is removed: `run` is
	// skipped while the container exists, so changing this mount requires
	// removing the container first.
	const mount = `${cfg.workspaceFolder}:${cfg.workspaceFolder}`;
	// Uncapped: this is where a first-run image pull happens, and the pull
	// makes steady progress for the whole time it runs (no output here, but
	// `run` with a local image exits in seconds — only the pull is
	// long, and that is exactly the case the cap must not break).
	const r = await run(
		eng.cli,
		[
			"run",
			"-d",
			"--name",
			name,
			// Published rather than relayed when the engine has no routable
			// container address (rootless Podman): nothing else can make these
			// reachable later.
			...(eng.portRouting === "published-only" ? publishArgs(cfg.appPort) : []),
			"-v",
			mount,
			"-w",
			cfg.projectCwd,
			// NB: no HOME override. Images whose user is not root (node:*-slim,
			// python:*-slim, golang:*) would get HOME=/root while running as
			// uid 1000, breaking every cache/config path with EACCES. The
			// image's own ENV HOME is the only correct value.
			cfg.image,
			"tail",
			"-f",
			"/dev/null",
		],
		onData,
		0,
	);
	if (r.code !== 0) throw new Error(`${eng.cli} run failed: ${r.stderr.trim()}`);
}
