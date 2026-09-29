import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { asJsonObject, parseJsonc, type JsonValue } from "./jsonc.js";

/**
 * Global devcontainer override: ~/.devcontainer/pi-override.json (JSONC).
 * The devcontainer CLI has no user-level override mechanism, so this
 * extension applies the file itself to every project's devcontainer:
 *
 *   {
 *     "features": { ... },   // merged in via `devcontainer up
 *                            //   --additional-features` (may trigger an
 *                            //   image rebuild once per feature set)
 *     "provision": [ ... ]   // bash -lc command lines, run once per
 *                            //   container (marker file in $HOME keyed
 *                            //   by the sha256 of the command set)
 *   }
 *
 * Provisioning is best-effort: a failure warns and the tools stay available.
 */
export const GLOBAL_OVERRIDE_PATH = join(homedir(), ".devcontainer", "pi-override.json");

export interface GlobalOverride {
	features?: Record<string, JsonValue>;
	provision?: string[];
	path: string;
}

export function loadGlobalOverride(): GlobalOverride {
	if (!existsSync(GLOBAL_OVERRIDE_PATH)) return { path: GLOBAL_OVERRIDE_PATH };
	try {
		const obj = asJsonObject(parseJsonc(readFileSync(GLOBAL_OVERRIDE_PATH, "utf-8")));
		if (!obj) return { path: GLOBAL_OVERRIDE_PATH };
		const features = asJsonObject(obj.features) ?? undefined;
		const provision = Array.isArray(obj.provision)
			? obj.provision.filter((c): c is string => typeof c === "string" && c.trim() !== "")
			: undefined;
		return { features, provision, path: GLOBAL_OVERRIDE_PATH };
	} catch {
		return { path: GLOBAL_OVERRIDE_PATH };
	}
}
