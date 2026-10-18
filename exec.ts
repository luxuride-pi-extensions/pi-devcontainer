import { spawn } from "node:child_process";

/** Default cap on one host-side command, in seconds. */
export const DEFAULT_RUN_TIMEOUT = 60;

/**
 * Run a command to completion, collecting stdout and stderr.
 *
 * `onData` receives both streams as they arrive, so a caller watching a long
 * bring-up can show what the process is doing instead of waiting in silence.
 * stderr is delivered too: `devcontainer up` and `docker pull` put their
 * progress there, not on stdout.
 *
 * Every call is bounded. A docker daemon wedged mid-request never answers
 * `docker inspect` — the process hangs with no output and no exit — and an
 * unbounded await would freeze `ensureReady` and the run tool with it, with
 * nothing on screen but silence. The cap kills the child and rejects with a
 * message naming the command and the timeout, so the failure is visible and
 * the session keeps working.
 *
 * `timeoutSeconds = 0` disables the cap entirely, for callers that know the
 * command legitimately runs for many minutes (a first-run image pull is one).
 */
export async function run(
	cmd: string,
	args: string[],
	onData?: (data: Buffer) => void,
	timeoutSeconds: number = DEFAULT_RUN_TIMEOUT,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		// detached so the timeout can kill the whole process group: the child
		// often spawns descendants (the CLI, `sh -c` children) that inherit
		// the stdio pipes, and a lone kill of the parent would leave them —
		// and 'close', which waits for the pipes — hanging until they exit.
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const collect = (d: Buffer, sink: Buffer[]) => {
			sink.push(d);
			onData?.(d);
		};
		child.stdout.on("data", (d: Buffer) => collect(d, out));
		child.stderr.on("data", (d: Buffer) => collect(d, err));
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			// The whole process group when there is one (`devcontainer up`
			// spawns children of its own); a plain child otherwise. Both paths
			// are raced by `close`, so an already-dead child is fine.
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			reject(e);
		};
		if (timeoutSeconds > 0) {
			timeoutHandle = setTimeout(() => {
				fail(new Error(`host command '${cmd}' timed out after ${timeoutSeconds}s with no output or exit`));
			}, timeoutSeconds * 1000);
		}
		child.on("error", (e) => fail(e));
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
		});
	});
}

export /** Shell-quote a string with single quotes. */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
