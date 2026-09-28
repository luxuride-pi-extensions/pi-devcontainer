

/**
 * Errors that are ordinary command outcomes, not proxy breakage. pi's
 * built-in bash tool throws for EVERY non-zero exit ("Command exited with
 * code N"), as well as for timeouts and aborts. None of those may disable
 * the devcontainer proxy — only a failure to run the command inside the
 * container (spawn/plumbing/bring-up) may.
 */
export const NON_BREAKING_BASH_ERROR_PATTERNS: RegExp[] = [
	/^aborted$/i,
	/Command aborted$/i,
	/^timeout:\d+$/i,
	/Command timed out after \d+ seconds$/i,
	/Command terminated without an exit code$/i,
	/Command exited with code \d+$/,
	/^devcontainer bring-up failed/i,
];

export function isProxyBreakError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return !NON_BREAKING_BASH_ERROR_PATTERNS.some((re) => re.test(msg));
}
