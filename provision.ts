import { createHash } from "node:crypto";

import { run } from "./exec.js";

/**
 * Stable stringify: object keys are emitted in sorted order at every depth so
 * the provisioning marker key depends only on the CONTENT of `features`, not
 * on the key order that happened to appear in the JSONC file. Without this,
 * reformatting pi-override.json could silently re-run (or skip) provisioning.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Run override provision commands once per container. Idempotency marker:
 * <home>/.pi-override-<sha256 of the feature set + command set, 16 hex>.
 * If the marker exists, nothing runs; if all commands exit 0, the marker is
 * written.
 *
 * `features` belongs in the marker key because features are baked into the
 * image and so alter the environment provision commands run in. Keying on
 * `provision` alone would leave a stale marker behind whenever a feature is
 * added or removed.
 *
 * Callers in docker-fallback mode pass no features: the CLI cannot apply them
 * there, so no image change can occur.
 */
export async function provisionContainer(
	notify: (msg: string, level: "info" | "warning") => void,
	execPrefix: string[],
	provision: string[],
	features?: Record<string, unknown>,
): Promise<void> {
	const marker = `.pi-override-${createHash("sha256")
		.update(stableStringify({ features: features ?? null, provision }))
		.digest("hex")
		.slice(0, 16)}`;
	// The marker is passed as a positional parameter rather than interpolated
	// into the script, so the script embeds no unescaped path. Note that
	// `${marker}` is a JS template placeholder while the unbraced `$HOME` is
	// left for bash to expand.
	//
	// The tuple type is load-bearing, and `run` takes (cmd, args) rather than
	// a rest parameter, so a full argv is unpacked explicitly — `run(...argv)`
	// cannot typecheck. `execPrefix[0]` is only string|undefined under
	// noUncheckedIndexedAccess, so it is asserted once here.
	const prefix = execPrefix[0] as string;
	const bash = (script: string): [string, ...string[]] => [prefix, ...execPrefix.slice(1), "bash", "-lc", script, "pi-override", marker];
	const runBash = (script: string) => {
		const argv = bash(script);
		return run(argv[0], argv.slice(1), undefined, 0);
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
			const r = await run(prefix, [...execPrefix.slice(1), "bash", "-lc", cmd], undefined, 0);
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
