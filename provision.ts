import { createHash } from "node:crypto";

import { run } from "./exec.js";

/**
 * Run override provision commands once per container. Idempotency marker:
 * <home>/.pi-override-<sha256 of the command set, 16 hex>. If the marker
 * exists, nothing runs; if all commands exit 0, the marker is written.
 */
export async function provisionContainer(
	notify: (msg: string, level: "info" | "warning") => void,
	execPrefix: string[],
	provision: string[],
): Promise<void> {
	const marker = `.pi-override-${createHash("sha256").update(provision.join("\n")).digest("hex").slice(0, 16)}`;
	// The marker is passed as a positional parameter rather than
	// interpolated into the script. Interpolation also worked: `${marker}`
	// is a JS template placeholder (marker is a known constant) while the
	// unbraced `$HOME` is left for bash to expand, so `[ -e $HOME/<marker> ]`
	// expanded correctly. Passing it as "$1" is still preferable — the
	// script no longer embeds an unescaped path, and it stays correct if a
	// marker ever contained shell metacharacters.
	// The tuple type is load-bearing, and `run` takes (cmd, args) rather than
	// a rest parameter, so a full argv is unpacked explicitly — `run(...argv)`
	// cannot typecheck. `execPrefix[0]` is only string|undefined under
	// noUncheckedIndexedAccess, so it is asserted once here.
	const prefix = execPrefix[0] as string;
	const bash = (script: string): [string, ...string[]] => [prefix, ...execPrefix.slice(1), "bash", "-lc", script, "pi-override", marker];
	const runBash = (script: string) => {
		const argv = bash(script);
		return run(argv[0], argv.slice(1));
	};
	let markerExists = false;
	try {
		markerExists = (await runBash('[ -e "$HOME/$1" ]')).code === 0;
	} catch {
		// probe failed - fall through and try provisioning
	}
	if (markerExists) return;
	notify(`Provisioning devcontainer (${provision.length} command(s), one-time)...`, "info");
	let allOk = true;
	for (const cmd of provision) {
		try {
			const r = await run(prefix, [...execPrefix.slice(1), "bash", "-lc", cmd]);
			if (r.code !== 0) {
				allOk = false;
				const detail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ");
				notify(`provision command failed (exit ${r.code}): ${cmd.slice(0, 60)} — ${detail}`.slice(0, 500), "warning");
			}
		} catch {
			allOk = false;
			notify(`provision command could not run: ${cmd.slice(0, 60)}`, "warning");
		}
	}
	if (!allOk) return; // no marker: retry next session
	try {
		await runBash('touch "$HOME/$1"');
	} catch {
		// marker write failed - provisioning simply re-runs next session
	}
}
