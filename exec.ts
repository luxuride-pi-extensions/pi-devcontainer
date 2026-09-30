import { spawn } from "node:child_process";

/**
 * Run a command to completion, collecting stdout and stderr.
 *
 * `onData` receives both streams as they arrive, so a caller watching a long
 * bring-up can show what the process is doing instead of waiting in silence.
 * stderr is delivered too: `devcontainer up` and `docker pull` put their
 * progress there, not on stdout.
 */
export async function run(
	cmd: string,
	args: string[],
	onData?: (data: Buffer) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const collect = (d: Buffer, sink: Buffer[]) => {
			sink.push(d);
			onData?.(d);
		};
		child.stdout.on("data", (d: Buffer) => collect(d, out));
		child.stderr.on("data", (d: Buffer) => collect(d, err));
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
		);
	});
}

export /** Shell-quote a string with single quotes. */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
