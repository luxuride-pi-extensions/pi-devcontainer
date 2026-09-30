import type { DevcontainerConfig } from "./types.js";
import { run } from "./exec.js";

export async function ensureDockerContainer(cfg: DevcontainerConfig, onData?: (data: Buffer) => void): Promise<void> {
	const name = cfg.containerName;
	if (!cfg.image) {
		throw new Error(
			'devcontainer.json has no "image" field and the devcontainer CLI is not available; cannot run the container with plain docker',
		);
	}
	const inspect = await run("docker", ["inspect", "-f", "{{.State.Status}}", name]);
	if (inspect.code === 0) {
		if (inspect.stdout.trim() === "running") return;
		await run("docker", ["start", name], onData);
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
	// run keeps its original mount until it is removed: `docker run` is
	// skipped while the container exists, so changing this mount requires
	// `docker rm` first.
	const mount = `${cfg.workspaceFolder}:${cfg.workspaceFolder}`;
	const r = await run(
		"docker",
		[
			"run",
			"-d",
			"--name",
			name,
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
	);
	if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
}
