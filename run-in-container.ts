import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { ensureDockerContainer } from "./docker.js";
import { shq } from "./exec.js";
import type { DevcontainerConfig } from "./types.js";

/**
 * Wait for the background bring-up started at session start, and report
 * failure as an error the tool can surface. A rejected `pendingUp` is the
 * NORMAL failure signal (the bring-up closure already notified the user), so
 * it is swallowed here and re-thrown as a single readable message.
 */
export async function settleBringUp(cfg: DevcontainerConfig, isEnabled: () => boolean): Promise<void> {
	if (!cfg.pendingUp) return;
	await cfg.pendingUp.catch(() => undefined);
	if (!isEnabled()) throw new Error("devcontainer bring-up failed; the container is not available");
}

export interface ResolvedCwd {
	/** Directory the command runs in, as the container sees it. */
	containerCwd: string;
	/** The same directory as the host sees it, so read/write/edit can target it. */
	hostCwd: string;
}

/**
 * Interpret the tool's `cwd` as a CONTAINER path, never as a host path.
 *
 * The whole point of the dedicated tool is that the two namespaces stop
 * leaking into each other: the model types a path it can see in the tool
 * result, and it is resolved against the container-side mount point
 * (e.g. /workspaces/<name>). Host paths are accepted only when they are
 * already the container's own view of the directory — which is exactly the
 * case in docker-fallback mode, where the workspace is mounted at its host
 * path.
 *
 * Returns a resolved pair, or throws with a hint rather than silently
 * rebasing: a mistyped host path deserves to be visible, not absorbed.
 */
export function resolveToolCwd(cfg: DevcontainerConfig, cwd: string | undefined): ResolvedCwd {
	const requested = (cwd ?? "").trim();

	// Docker fallback: the workspace is mounted at its host path, so host and
	// container paths coincide and a relative path resolves against the
	// project directory directly.
	if (!cfg.useCli) {
		const containerCwd = requested === "" ? cfg.projectCwd : isAbsolute(requested) ? requested : resolve(cfg.projectCwd, requested);
		return { containerCwd, hostCwd: containerCwd };
	}

	if (requested === "") {
		if (!cfg.remoteWorkspace) throw new Error(unknownMountHint(cfg));
		return { containerCwd: cfg.remoteWorkspace, hostCwd: cfg.projectCwd };
	}
	if (isAbsolute(requested)) {
		// An absolute path is taken at face value — it is a container path. The
		// host path is only reported when it lies under the mount, so a path
		// like /etc still works and simply reports no host counterpart.
		const rel = cfg.remoteWorkspace ? relative(cfg.remoteWorkspace, requested) : "..";
		const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		return { containerCwd: requested, hostCwd: inside ? resolve(cfg.configRoot, rel) : requested };
	}
	if (!cfg.remoteWorkspace) throw new Error(unknownMountHint(cfg));
	const containerCwd = resolve(cfg.remoteWorkspace, requested);
	return { containerCwd, hostCwd: resolve(cfg.configRoot, requested) };
}

function unknownMountHint(cfg: DevcontainerConfig): string {
	return (
		"the container workspace mount point is unknown, so a relative cwd cannot be resolved. " +
		`Start the container (/devcontainer is gone; restart the session) or pass an absolute container path. ` +
		`Host project directory: ${cfg.projectCwd}`
	);
}

export interface RunResult {
	exitCode: number;
	/** Combined stdout+stderr, decoded. */
	output: string;
	containerCwd: string;
	hostCwd: string;
	/** Set when the command was killed rather than exiting on its own. */
	failure?: string;
}

/**
 * Run one command inside the container and collect its output.
 *
 * `bash -c`, not `-lc`: the login shell re-runs the container's profile
 * scripts on every call, which is slow and can reintroduce the very host
 * PATH/toolchain confusion this tool exists to avoid. Users who need profile
 * setup should put it in the devcontainer's own postCreateCommand.
 */
export function runInContainer(
	cfg: DevcontainerConfig,
	params: { command: string; cwd?: string; stdin?: string; timeout?: number },
	onData?: (data: Buffer) => void,
	signal?: AbortSignal,
): Promise<RunResult> {
	const { containerCwd, hostCwd } = resolveToolCwd(cfg, params.cwd);
	const script = `cd ${shq(containerCwd)} && ${params.command}`;
	const argv: [string, ...string[]] = cfg.useCli
		? ["devcontainer", "exec", "--workspace-folder", cfg.workspaceFolder, "--", "bash", "-c", script]
		: ["docker", "exec", "-i", cfg.containerName, "bash", "-c", script];

	return new Promise<RunResult>((resolvePromise, reject) => {
		// detached + unref: the child must not hold the node process open when
		// the session ends, but a detached process group is still needed so
		// abort can kill the whole tree (devcontainer exec spawns children).
		const child = spawn(argv[0], argv.slice(1), {
			cwd: cfg.projectCwd,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.unref();

		const chunks: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const collect = (d: Buffer) => {
			chunks.push(d);
			onData?.(d);
		};
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		};
		const onAbort = () => kill();

		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		if (params.timeout !== undefined && params.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				kill();
			}, params.timeout * 1000);
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			reject(err);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			const output = Buffer.concat(chunks).toString();
			const aborted = signal?.aborted === true;
			resolvePromise({
				exitCode: code ?? (aborted || timedOut ? 1 : 1),
				output,
				containerCwd,
				hostCwd,
				failure: aborted ? "aborted" : timedOut ? `timeout:${params.timeout}` : undefined,
			});
		});

		// stdin is piped unconditionally: with no input the pipe is simply
		// closed, which is what a command reading stdin expects.
		child.stdin?.on("error", () => {
			/* container closed stdin early; the command's own output is the signal */
		});
		child.stdin?.end(params.stdin ?? "");
	});
}

/** Await bring-up, then run. Shared by every tool call. */
export async function ensureReady(cfg: DevcontainerConfig, isEnabled: () => boolean): Promise<void> {
	await settleBringUp(cfg, isEnabled);
	if (!cfg.useCli) await ensureDockerContainer(cfg);
}
