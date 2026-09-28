import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { ensureDockerContainer } from "./docker.js";
import { shq } from "./exec.js";
import type { DevcontainerConfig } from "./types.js";

/**
 * `warn` is called when a requested cwd lies outside the mounted workspace,
 * in which case the command is silently re-based onto the workspace root
 * (the host path does not exist inside the container). The call site
 * de-duplicates the warning.
 */
export function createContainerOps(
	cfg: DevcontainerConfig,
	isEnabled: () => boolean,
	warn: (cwd: string) => void,
): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			// Session start may still be bringing the container up in the
			// background (e.g. a first-run image pull) — wait for it before
			// running anything inside. A failed bring-up already disabled
			// the proxy; throw so the caller falls back to the local shell.
			if (cfg.pendingUp) {
				await cfg.pendingUp.catch(() => undefined);
				if (!isEnabled()) throw new Error("devcontainer bring-up failed; proxy disabled");
			}
			// Cheap belt-and-braces re-check for detached sessions.
			if (!cfg.useCli) await ensureDockerContainer(cfg);

				// CLI-managed containers mount the workspace folder (the directory
				// containing the .devcontainer config — which may be a PARENT of the
				// project) at a virtualized path (e.g. /workspaces/<name>), not the
				// host path — translate cwd relative to that mount root.
				// The docker fallback mounts at the host path, so no translation.
				let innerCwd: string | undefined = cwd;
				if (cfg.useCli) {
					// The kernel sees the canonical path (/var/home/...) which may
					// differ from the shell's cwd (/home/...). Translate relative
					// to the canonical mount root, not the raw one.
					let rel: string;
					let outsideMount = false;
					if (cwd === cfg.configRoot || cwd === cfg.projectCwd) rel = "";
					else {
						const rc = relative(cfg.configRoot, cwd);
						if (rc === "" || (!rc.startsWith("..") && !isAbsolute(rc))) rel = rc;
						else {
							const cr = relative(cfg.canonicalCwd, cwd);
							if (cr === "" || (!cr.startsWith("..") && !isAbsolute(cr))) rel = cr;
							else {
								// cwd is outside the mounted workspace: run from the
								// workspace root instead of failing on a host path the
								// container cannot see, and say so.
								rel = "";
								outsideMount = true;
							}
						}
					}
				if (outsideMount) warn(cwd);
				// When the mount point is known, always cd somewhere real: the
				// CLI's default cwd can be a host path the container cannot see.
				// When it is NOT known (the remoteWorkspaceFolder JSON field was
				// absent AND the probe failed), emit no `cd` at all and let the
				// container's own default working directory apply. The previous
				// `"$HOME"` fallback was passed through shq() and therefore
				// arrived as the LITERAL string `cd '$HOME'`, so every command
				// died with "cd: $HOME: No such file or directory" — and since
				// that surfaces as an ordinary non-zero exit it never disabled
				// the proxy, so the agent just saw endless failures.
				innerCwd = cfg.remoteWorkspace
					? rel === ""
						? cfg.remoteWorkspace
						: resolve(cfg.remoteWorkspace, rel)
					: undefined;
			}

			// The devcontainer CLI's `exec` has no --env flag, and host absolute
			// paths (e.g. ~) are meaningless inside the container — but the
			// agent still carries the host cwd in its system prompt and will
			// happily type host paths into commands. Make the mapping explicit
			// as environment so it's discoverable (echo $PI_HOST_CWD).
			//
			// PI_HOST_CWD is exported in BOTH modes (it is just a host path and
			// needs no CLI), because the tool description promises it
			// unconditionally; only PI_DEVCONTAINER_WORKSPACE depends on a
			// resolved mount point.
			//
			// pi's built-in tool hands us a fully-resolved process env
			// (getShellEnv() plus the PI_SESSION_* metadata it deliberately
			// exposes). Only the PI_* keys are forwarded: exporting the whole
			// host environment would leak the host HOME/PATH and shadow the
			// container's own toolchain, which is a worse bug than a missing
			// variable. This keeps the documented "inspect PI_* env vars"
			// promise working inside the container.
			const piEnvExports = Object.entries(env ?? {})
				.filter(([key]) => key.startsWith("PI_"))
				.map(([key, value]) => `${key}=${shq(value ?? "")}`)
				.join(" ");
			const hostNote =
				`export PI_DEVCONTAINER=1 PI_HOST_CWD=${shq(cfg.projectCwd)} ` +
				(piEnvExports ? `${piEnvExports} ` : "") +
				// Last, so a stray host PI_DEVCONTAINER_WORKSPACE cannot win.
				(cfg.remoteWorkspace ? `PI_DEVCONTAINER_WORKSPACE=${shq(cfg.remoteWorkspace)} ` : "") +
				"; ";
			const inner = innerCwd !== undefined ? `${hostNote}cd ${shq(innerCwd)} && ${command}` : `${hostNote}${command}`;
			const argv: [string, ...string[]] = cfg.useCli
				? ["devcontainer", "exec", "--workspace-folder", cfg.workspaceFolder, "--", "bash", "-lc", inner]
				: ["docker", "exec", "-i", cfg.containerName, "bash", "-lc", inner];

			return new Promise((resolve, reject) => {
				const child = spawn(argv[0], argv.slice(1), {
					cwd: cfg.projectCwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const kill = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				const onAbort = () => kill();

					// `detached: true` (needed to kill the whole process group on
					// abort) would keep node alive after the session ends, so the
					// handle is unref'd: the process can exit while the child runs.
					child.unref();

					if (timeout !== undefined && timeout > 0) {
						timeoutHandle = setTimeout(() => {
												timedOut = true;
												kill();
						}, timeout * 1000);
					}

					child.stdout?.on("data", onData);
					child.stderr?.on("data", onData);
					// (stdout and stderr stay merged: the devcontainer CLI writes
					// build/attach progress to stderr during `up`, but that output
					// is piped away — `exec` itself only forwards the command.)
					child.on("error", (err) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						reject(err);
					});
					signal?.addEventListener("abort", onAbort, { once: true });

					child.on("close", (code) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						else resolve({ exitCode: code ?? 1 });
					});
				});
			},
		};
}
