import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { asJsonObject, parseJsonc, type JsonValue } from "./jsonc.js";

export function alreadyInContainer(): boolean {
	if (existsSync("/run/.containerenv")) return true;
	if (process.env.VSCODE_INJECTION && process.env.DEVCONTAINER_WORKSPACE_FOLDER) return true;
	return false;
}

/** One candidate config location inside a directory. */
interface Candidate {
	/** Absolute path of the devcontainer.json file. */
	path: string;
	/** Directory that contains it — what a `workspaceFolder` relative path in
	 *  the config resolves against. NOT the workspace folder itself. */
	configDir: string;
	/** True for `.devcontainer/devcontainer.json` and named variants — the
	 *  locations the CLI itself recognizes. The bare file is checked last. */
	canonical: boolean;
}

/**
 * Candidate locations in ONE directory, in preference order:
 * `.devcontainer/devcontainer.json`, every `.devcontainer/<name>/
 * devcontainer.json` (multiple configs, like the CLI offers them), then the
 * legacy bare `devcontainer.json`.
 */
function candidatesIn(dir: string): Candidate[] {
	const out: Candidate[] = [];
	const devcontainerDir = join(dir, ".devcontainer");
	if (existsSync(devcontainerDir)) {
		out.push({ path: join(devcontainerDir, "devcontainer.json"), configDir: devcontainerDir, canonical: true });
		let entries: string[] = [];
		try {
			entries = readdirSync(devcontainerDir);
		} catch {
			// unreadable .devcontainer: the default location above still counts
		}
		// Names sort deterministically; only strings reach this sort.
		for (const name of [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
			if (name === "devcontainer.json") continue;
			out.push({ path: join(devcontainerDir, name, "devcontainer.json"), configDir: join(devcontainerDir, name), canonical: true });
		}
	}
	out.push({ path: join(dir, "devcontainer.json"), configDir: dir, canonical: false });
	return out;
}

/**
 * Find and parse the devcontainer config for `cwd`.
 *
 * Search order, mirroring the devcontainer CLI / VS Code discovery:
 *  1. <cwd>/.devcontainer/devcontainer.json
 *  2. <cwd>/.devcontainer/<name>/devcontainer.json (named configs, sorted)
 *  3. <cwd>/devcontainer.json  (legacy location)
 *
 * Then the PARENT directories are walked the same way. The CLI itself does
 * not search upward, so `root` stays the directory the search started in —
 * the workspace the container should mount — and the caller passes the file
 * to `devcontainer up`/`exec` as `--config` whenever it is NOT the default
 * location in that directory, which is the only way the CLI sees it.
 *
 * Returns `configDir`: the directory containing the config file, for
 * resolving relative paths inside it; `multi` — the name of the matched
 * subdirectory config when one of those was chosen, so a project with
 * several configs can be told apart in messages.
 */
export function loadDevcontainerJson(cwd: string): {
	config: Record<string, JsonValue> | null;
	path: string | null;
	root: string | null;
	configDir: string | null;
	multi: string | null;
} {
	// Walk cwd, then its parents. A filesystem root's parent is itself, which
	// is what ends the walk instead of an infinite loop.
	for (let dir = cwd; ; dir = dirname(dir)) {
		for (const candidate of candidatesIn(dir)) {
			if (!existsSync(candidate.path)) continue;
			try {
				const obj = asJsonObject(parseJsonc(readFileSync(candidate.path, "utf-8")));
				const multi = candidate.canonical && candidate.configDir !== join(dir, ".devcontainer") ? basename(candidate.configDir) : null;
				return { config: obj, path: candidate.path, root: cwd, configDir: candidate.configDir, multi };
			} catch {
				return { config: null, path: candidate.path, root: cwd, configDir: candidate.configDir, multi: null };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return { config: null, path: null, root: null, configDir: null, multi: null };
	}
}

export function hasDevcontainerCli(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("devcontainer", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}
