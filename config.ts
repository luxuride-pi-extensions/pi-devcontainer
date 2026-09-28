import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonObject, parseJsonc, type JsonValue } from "./jsonc.js";

export function alreadyInContainer(): boolean {
	if (existsSync("/run/.containerenv")) return true;
	if (process.env.VSCODE_INJECTION && process.env.DEVCONTAINER_WORKSPACE_FOLDER) return true;
	return false;
}

/**
 * Find and parse the devcontainer config for `cwd`.
 *
 * Search order, mirroring the devcontainer CLI / VS Code discovery:
 *  1. <cwd>/.devcontainer/devcontainer.json
 *  2. <cwd>/devcontainer.json  (legacy location)
 *
 * Only the project directory itself is checked — the devcontainer CLI
 * (0.89.0) does not search upward, and configs in parent directories are
 * intentionally not loaded.
 *
 * Returns `root`: the directory that contains the config (always `cwd`
 * when found).
 */
export function loadDevcontainerJson(cwd: string): { config: Record<string, JsonValue> | null; path: string | null; root: string | null } {
	const candidates = [join(cwd, ".devcontainer", "devcontainer.json"), join(cwd, "devcontainer.json")];
	for (const p of candidates) {
		if (existsSync(p)) {
			try {
				const obj = asJsonObject(parseJsonc(readFileSync(p, "utf-8")));
				return { config: obj, path: p, root: cwd };
			} catch {
				return { config: null, path: p, root: cwd };
			}
		}
	}
	return { config: null, path: null, root: null };
}

export function hasDevcontainerCli(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("devcontainer", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}
