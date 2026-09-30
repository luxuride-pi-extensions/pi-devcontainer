/**
 * Bring-up progress log.
 *
 * A first `devcontainer up` spends nearly all of its time pulling images and
 * building feature layers, and the first tool call sits in `await pendingUp`
 * for that whole time. With nothing emitted, the row stays blank and a slow
 * pull is indistinguishable from a hung container — which is exactly how it
 * reads. So the bring-up's own stdout/stderr is kept here and streamed to
 * whoever is waiting on it.
 *
 * Chunks arrive mid-line, so text is buffered until a line break. Docker
 * reports pull progress with bare carriage returns rather than newlines, and
 * those count as line breaks here: one CR-terminated progress frame per line
 * is exactly the right granularity to show.
 */

const MAX_LINES = 200;

export interface BringUpProgress {
	/** Feed raw bring-up output in. */
	append(chunk: string): void;
	/** Stream lines to `listener`, replaying what has been seen so far. */
	subscribe(listener: (line: string) => void): () => void;
	/** The retained lines, for a caller that only reports them at the end. */
	snapshot(): string;
}

export class BringUpLog implements BringUpProgress {
	private lines: string[] = [];
	private listeners = new Set<(line: string) => void>();
	private buffered = "";

	append(chunk: string): void {
		const parts = (this.buffered + chunk).split(/\r\n|\n|\r/);
		this.buffered = parts.pop() ?? "";
		for (const line of parts) this.push(line);
	}

	subscribe(listener: (line: string) => void): () => void {
		this.listeners.add(listener);
		for (const line of this.lines) listener(`${line}\n`);
		return () => {
			this.listeners.delete(listener);
		};
	}

	snapshot(): string {
		const lines = this.buffered ? [...this.lines, this.buffered] : this.lines;
		return lines.join("\n");
	}

	/**
	 * Push anything buffered onto a line boundary. Called once bring-up has
	 * finished, so a last line that arrived without a trailing newline is not
	 * lost from the report a failed call shows.
	 */
	flush(): void {
		if (!this.buffered) return;
		const line = this.buffered;
		this.buffered = "";
		this.push(line);
	}

	private push(line: string): void {
		// Blank lines are what most progress output is padded with; keeping
		// them would push the interesting frames out of the bound below.
		if (line.trim() === "") return;
		this.lines.push(line);
		if (this.lines.length > MAX_LINES) this.lines.shift();
		for (const listener of this.listeners) listener(`${line}\n`);
	}
}

/**
 * Which part of the pull/build the log is showing, judged from what docker
 * prints.
 *
 * A raw progress line means little on its own ("abc123: Downloading 41.2
 * MB/120 MB" repeated) and a bare spinner means nothing at all. Naming the
 * PHASE is what tells the user whether the work is advancing, and this is
 * shown for the whole background bring-up, so the wait is visibly waiting.
 *
 * Ordered LAST STAGE FIRST, first match wins. A log holds every stage the
 * run has passed through, so the latest stage present is the one happening
 * now: "Extracting" and "Download complete" both stay in the log after the
 * layers land, and reporting the download would say a finished pull is still
 * running.
 */
export function describePhase(lines: readonly string[]): string {
	const has = (needle: string): boolean => lines.some((l) => l.includes(needle));
	// The CLI numbers its own steps ("[2/4] Starting container") and prints a
	// bare "Completed" at the end; buildx also prints "Running apt-get update"
	// for an ordinary build step, so these must be anchored to the CLI's own
	// shape or a feature's apt run would be read as a finished container.
	if (has("Completed") || lines.some((l) => /^\[\d+\/\d+\] Starting/.test(l.trim()))) return "container starting";
	if (lines.some((l) => /^\[\d+\/\d+\] Creating/.test(l.trim()))) return "creating the container";
	if (has("Feature")) return "installing devcontainer features";
	// BuildKit's per-step lines are `#8 [2/3] RUN ...` while it runs and
	// `#8 0.329 Running apt-get ...` once a step has output; between them they
	// are the only sign of progress during a long build.
	if (
		has("naming to ") ||
		has("buildkit") ||
		has("Building") ||
		lines.some((l) => /^#\d+ (?:\[\d+\/\d+\]|[\d.]+s?\s)/.test(l))
	)
		return "building image from the devcontainer config";
	if (has("Pull complete") || has("Downloaded newer image") || has("Status: Downloaded")) return "image pulled";
	if (has("Download complete") && has("Extracting")) return "extracting downloaded layers";
	if (has("Extracting")) return "extracting image layers";
	// A feature build pulls the base image through buildx, which reports bytes
	// rather than "Downloading": `#4 sha256:ab.. 12.3MB / 221.26MB 41.2s`. The
	// `done` suffix is what makes those stale, so only an unfinished one counts
	// as a live download.
	if (lines.some((l) => BYTES_RE.test(l) && !l.trimEnd().endsWith("done"))) return "downloading image layers";
	if (has("Download complete") || has("Pulling fs layer") || has("Downloading")) return "downloading image layers";
	return "pulling and building the devcontainer image";
}

/**
 * A byte counter in a progress line, as buildx and `docker pull` both print it:
 * `12.3MB / 221.26MB`, `415B / 415B`, `1.2GB / 3GB`.
 */
const BYTES_RE = /[\d.]+[kMG]?B\s*\/\s*[\d.]+[kMG]?B/;

/** Fit a line to one terminal row; the status bar has a single line for it. */
function oneLine(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 150 ? `${trimmed.slice(0, 147)}...` : trimmed;
}

/** The part of a UI this widget needs, so a test can pass a stub. */
export interface WidgetUi {
	setStatus?: (key: string, text: string | undefined) => void;
	setWorkingMessage?: (message: string | undefined) => void;
}

/**
 * A status-bar row for bring-up that the user did not have to ask for.
 *
 * The run tool blocks until the container is up, and a first-run pull takes
 * minutes; the user is left watching a tool row that has nothing to show yet.
 * This puts elapsed time and the current phase in the status bar for as long
 * as the work lasts. A `notify` call would not do: a notification is
 * dismissed, and this has to be present the whole time.
 *
 * Optional on every method, because a non-TUI mode, or a UI context predating
 * these methods, must degrade to showing nothing rather than throwing during
 * a long operation. The log is re-read on a timer instead of pushed, since
 * the log is shared with the tool call's own subscription.
 */
export function startProgressWidget(ui: WidgetUi | undefined, log: BringUpProgress, label: string): () => void {
	if (!ui?.setStatus) return () => {};
	const started = Date.now();
	const tick = (): void => {
		const lines = log.snapshot().split("\n").filter(Boolean);
		const elapsed = Math.round((Date.now() - started) / 1000);
		// The newest line wins when it is one of the lines that visibly move,
		// because a changing percentage is the clearest evidence of life; the
		// phase name is used for the many steps that print nothing at all.
		const last = lines[lines.length - 1] ?? "";
		const detail = /Downloading|Extracting|Pulling|Waiting|Download complete/.test(last) || BYTES_RE.test(last)
			? oneLine(last)
			: describePhase(lines);
		ui.setStatus?.("devcontainer", `⏳ devcontainer ${elapsed}s — ${detail} (${label})`);
		ui.setWorkingMessage?.(`devcontainer ${label} — ${elapsed}s`);
	};
	tick();
	// Unref'd so an idle widget cannot keep the process alive; a widget that
	// matters runs inside a live session that is alive anyway.
	const handle = setInterval(tick, 1000);
	handle.unref?.();
	return () => {
		clearInterval(handle);
		ui.setStatus?.("devcontainer", undefined);
		ui.setWorkingMessage?.(undefined);
	};
}
