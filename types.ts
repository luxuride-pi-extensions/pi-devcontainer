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
	 * /workspaces/<name>). The CLI mounts at a container path rather than the
	 * host path, so a host-path `cd` inside the container would fail.
	 */
	remoteWorkspace?: string;
	/**
	 * Background bring-up (`devcontainer up` / docker create) kicked off at
	 * session start; the first command awaits it before running.
	 */
	pendingUp?: Promise<void>;
}
