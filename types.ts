import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
export { type BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * The slice of the UI context this extension touches. `notify` is included
 * because notifications are emitted from places that only hold this object
 * (the `setStatus` closure, `disableProxy`).
 */
export type StatusUI = Pick<ExtensionUIContext, "setStatus" | "theme" | "notify">;

export interface DevcontainerConfig {
	projectCwd: string;
	/** canonical (symlink-resolved) project path — what the kernel sees */
	canonicalCwd: string;
	/** canonical directory that contains the .devcontainer config (the container's mount root) */
	configRoot: string;
	containerName: string;
	image?: string;
	/**
	 * Host folder to bind-mount. With the devcontainer CLI this MUST be the
	 * directory containing the `.devcontainer` config (the CLI does not
	 * search upward), which may differ from `config.workspaceFolder`; with
	 * the docker fallback it is the config's declared `workspaceFolder`.
	 */
	workspaceFolder: string;
	useCli: boolean;
	/**
	 * Where the workspace is mounted inside the CLI-managed container (e.g.
	 * /workspaces/<name>). The devcontainer CLI (>= 0.8) no longer mounts at
	 * the host path, so host-path `cd`s inside the container would fail.
	 */
	remoteWorkspace?: string;
	/**
	 * Background bring-up (`devcontainer up` / docker create) kicked off at
	 * session start; the first command awaits it before running.
	 */
	pendingUp?: Promise<void>;
}
