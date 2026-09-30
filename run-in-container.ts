import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { ensureDockerContainer } from "./docker.js";
import { shq } from "./exec.js";
import { startProgressWidget } from "./progress.js";
import type { BringUpProgress, WidgetUi } from "./progress.js";
import type { DevcontainerConfig } from "./types.js";

/** Bring-up output kept for the error a timed-out wait reports. */
const PROGRESS_REPORT_LINES = 20;

/**
 * Stands in for a bring-up that has no log yet (a docker-fallback start, or a
 * second wait after the first cleared it), so the widget needs no null checks
 * of its own and shows the generic phase rather than nothing.
 */
const EMPTY_LOG: BringUpProgress = { append: () => {}, subscribe: () => () => {}, snapshot: () => "" };

export interface SettleOptions {
	/** Whether the tool is still enabled; a disabled tool is never usable. */
	isEnabled: () => boolean;
	/** Called with each line of bring-up output as it arrives. */
	onProgress?: (line: string) => void;
	/**
	 * Seconds to wait before giving up and reporting that bring-up is still
	 * running. Undefined or <= 0 waits as long as it takes.
	 */
	waitBudgetSeconds?: number;
	/**
	 * Cancels the WAIT, not the bring-up. The bring-up is a session-wide
	 * background process, so a cancelled call must leave it running for the
	 * next one; only the caller's own waiting stops.
	 */
	signal?: AbortSignal;
	/**
	 * Where to show bring-up progress in the user's status bar, for the
	 * duration of the wait. Optional: without it the wait is silent apart
	 * from onProgress, and nothing breaks.
	 */
	ui?: WidgetUi;
}

/**
 * Wait for the background bring-up started at session start, and report
 * failure as an error the tool can surface. A rejected `pendingUp` is the
 * NORMAL failure signal (the bring-up closure already notified the user), so
 * it is swallowed here and re-thrown as a single readable message.
 *
 * The wait is BOUNDED. Bring-up on a first run spends its time pulling images
 * and building feature layers, which can be many minutes; an unbounded await
 * produces a blank tool row for all of it, and a blank row reads as a hang
 * rather than as progress. So progress lines are streamed out while waiting,
 * and a wait that runs past its budget ends with a message naming what is
 * happening and how to keep waiting — an informed decision instead of a
 * stuck call.
 */
export async function settleBringUp(cfg: DevcontainerConfig, opts: SettleOptions): Promise<void> {
	if (!cfg.pendingUp) return;
	const log = cfg.bringUpLog;
	const unsubscribe = log && opts.onProgress ? log.subscribe(opts.onProgress) : undefined;
	/**
	 * The waiter's own stream is only as good as the caller's onProgress, so a
	 * caller that renders nothing (a command, a test) still gets a status bar
	 * the user can see. Independent subscription, and stopped with the wait.
	 */
	const stopWidget = startProgressWidget(opts.ui, log ?? EMPTY_LOG, cfg.projectCwd);
	// A timer that is never cleared would hold the process open at shutdown.
	const budget = opts.waitBudgetSeconds !== undefined && opts.waitBudgetSeconds > 0 ? opts.waitBudgetSeconds * 1000 : 0;
	let timeoutHandle: NodeJS.Timeout | undefined;
	// The reason bring-up failed is the single most useful thing the waiting
	// call can report, so it is captured rather than discarded.
	let upError: string | null = null;
	try {
		// Set by the bring-up side only. A timer that fires leaves it false,
		// which is what distinguishes "still being created" from "done".
		let upSettled = false;
		try {
			await Promise.race([
				cfg.pendingUp.catch((err: unknown) => {
					upError = err instanceof Error ? err.message : String(err);
				}).then(() => {
					upSettled = true;
				}),
				new Promise<void>((resolveTimeout) => {
					if (budget <= 0) return;
					timeoutHandle = setTimeout(resolveTimeout, budget);
				}),
				// The user's own cancel has to end the wait as surely as the
				// timeout does: without this a cancel arriving during a
				// multi-minute pull leaves the call hanging in a void nothing
				// can be resolved into.
				new Promise<void>((resolveAbort) => {
					if (!opts.signal) return;
					if (opts.signal.aborted) {
						resolveAbort();
						return;
					}
					opts.signal.addEventListener("abort", () => resolveAbort(), { once: true });
				}),
			]);
		} finally {
			// Never clear the timeout on the path where it is what resolved the
			// race, or the pending handle itself keeps the process alive.
			if (timeoutHandle && upSettled) clearTimeout(timeoutHandle);
		}
		if (!upSettled) {
			if (opts.signal?.aborted) throw new Error("aborted");
			const report = (log?.snapshot() ?? "")
				.split("\n")
				.filter(Boolean)
				.slice(-PROGRESS_REPORT_LINES);
			throw new Error(
				[
					`the devcontainer is still being created after ${Math.round(budget / 1000)}s — a first-run image pull and feature build, not a failure.`,
					report.length > 0 ? ["last bring-up output:", ...report.map((l) => `  ${l}`)].join("\n") : "",
					"Call the command again with a larger `waitForContainer` (e.g. 900) to keep waiting, or watch it yourself on the host with `devcontainer up --workspace-folder <project>`.",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
	} finally {
		unsubscribe?.();
		stopWidget();
	}
	if (upError !== null) {
		const report = (log?.snapshot() ?? "")
			.split("\n")
			.filter(Boolean)
			.slice(-PROGRESS_REPORT_LINES);
		throw new Error(
			[
				`devcontainer bring-up failed: ${upError}`,
				report.length > 0 ? ["last bring-up output:", ...report.map((l) => `  ${l}`)].join("\n") : "",
				`The host directory is ${cfg.projectCwd}; fix the config with \`create_devcontainer\` and retry.`,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	if (!opts.isEnabled()) throw new Error("devcontainer bring-up failed; the container is not available");
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
export async function ensureReady(cfg: DevcontainerConfig, opts: SettleOptions): Promise<void> {
	await settleBringUp(cfg, opts);
	if (!cfg.useCli) await ensureDockerContainer(cfg);
}
