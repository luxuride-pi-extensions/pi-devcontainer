/**
 * Presentation for the `devcontainer` tool: the same shape pi's own shell
 * tool uses, so a command in the container reads exactly like a command on
 * the host.
 *
 * Layout: the command on its own line, a blank line, up to five lines of
 * output with a "... (n earlier lines, ctrl+o to expand)" hint above them,
 * and a duration footer. Output is pushed to the TUI as it arrives (throttled,
 * and capped at a bounded tail) so a long build is visibly progressing rather
 * than looking hung.
 *
 * The key hint and the visual-line truncation come from pi's public entry
 * point, so the expand hint matches the built-in shell tool exactly. Colours
 * come from the `Theme` instance pi passes to every renderer, since the
 * module-level `theme` singleton is not exported.
 */
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { keyHint, truncateToVisualLines, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

/** Mirrors pi's own shell preview: lines of output shown when collapsed. */
const PREVIEW_LINES = 5;

/** Matches pi's shell tool update throttle; a faster one only burns redraws. */
export const UPDATE_THROTTLE_MS = 100;

/**
 * Longest tail of output kept for the live view. A build can emit megabytes
 * and the TUI must not hold all of it; the model still receives the full,
 * separately-truncated result, so this is a display bound only.
 */
const MAX_DISPLAY_BYTES = 64 * 1024;

/** Exposed so the bounded-tail behaviour is testable without a 64 KB literal. */
export const MAX_DISPLAY_BYTES_FOR_TEST = MAX_DISPLAY_BYTES;

export interface DevcontainerDetails {
	exitCode?: number;
	containerCwd?: string;
	hostCwd?: string;
	truncated?: boolean;
	/** Output size so far, reported live so the footer stays honest. */
	totalBytes?: number;
	totalLines?: number;
}

/**
 * The renderer arguments pi passes. `ToolRenderContext` is not part of the
 * public entry point, so the fields actually used are declared here.
 */
interface RenderContext {
	/** Milliseconds timestamp for when execution began, set on first render. */
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	cachedWidth?: number;
	cachedLines?: string[];
	cachedSkipped?: number;
	lastOutput?: string;
}

interface RenderArgs {
	args?: Record<string, unknown>;
	lastComponent?: Component;
	state: RenderContext;
	executionStarted: boolean;
	isError: boolean;
	expanded: boolean;
	isPartial: boolean;
	showImages: boolean;
	invalidate: () => void;
}

/**
 * Bash's result component reuses the render context's own `state` object for
 * its width/line cache rather than owning one, and passes the context through
 * on every rebuild. This is the same approach: one cache, keyed on the output
 * text as well as the width, because a streaming update re-renders at the
 * same width with different content.
 */
type ResultComponent = Container;

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const total = Math.floor(seconds);
	if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
	return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

function commandText(args: Record<string, unknown> | undefined, theme: Theme): string {
	const command = typeof args?.command === "string" ? args.command : undefined;
	const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
	const tail = typeof args?.tail === "number" ? args.tail : undefined;
	// The `devcontainer` prefix is what separates this row from a host
	// command: the rest of the row is deliberately shaped like a shell
	// command, so an unlabelled one would read as the same tool changing
	// environments.
	//
	// The tail cap is shown because the row and the model's copy of the
	// output differ once it is set; a row ending at 5 lines with no
	// explanation reads as the command having produced that much.
	const suffix =
		(timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "") + (tail !== undefined ? theme.fg("muted", ` (tail ${tail})`) : "");
	const display = command ? command : theme.fg("toolOutput", "...");
	return theme.fg("accent", "devcontainer") + theme.fg("toolTitle", theme.bold(` $ ${display}`)) + suffix;
}

function outputOf(result: AgentToolResult<DevcontainerDetails>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Concatenate the streamed chunks, keeping only the tail. Held as a string
 * rather than an array of buffers so the TUI renders exactly what the tail
 * contains, with no per-chunk boundary artefacts.
 */
export class OutputTail {
	private text = "";

	append(chunk: string): void {
		this.text += chunk;
		if (this.text.length > MAX_DISPLAY_BYTES) {
			// Cut on a line boundary so the top of the view is never a fragment.
			const cut = this.text.length - MAX_DISPLAY_BYTES;
			const nl = this.text.indexOf("\n", cut);
			this.text = nl === -1 ? this.text.slice(cut) : this.text.slice(nl + 1);
		}
	}

	value(): string {
		return this.text;
	}

	/** Line and byte counts for the live footer. */
	counts(): { totalLines: number; totalBytes: number } {
		let lines = 0;
		for (let i = 0; i < this.text.length; i++) if (this.text.charCodeAt(i) === 10) lines++;
		return { totalLines: this.text === "" ? 0 : lines + 1, totalBytes: this.text.length };
	}
}

function rebuild(
	component: Container,
	result: AgentToolResult<DevcontainerDetails>,
	options: ToolRenderResultOptions,
	state: RenderContext,
	theme: Theme,
): void {
	component.clear();
	const output = outputOf(result);

	if (output) {
		const styled = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styled}`, 0, 0));
		} else {
			// The preview is cached against the output text as well as the
			// width: a streaming update re-renders with the same width but
			// different content, which a width-only key would not notice.
			if (state.lastOutput !== output) {
				state.lastOutput = output;
				state.cachedWidth = undefined;
			}
			component.addChild({
				render: (width: number): string[] => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const truncated = truncateToVisualLines(styled, PREVIEW_LINES, width);
						state.cachedLines = truncated.visualLines;
						state.cachedSkipped = truncated.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const details = result.details;
	if (details?.totalLines) {
		const parts = [`${details.totalLines} line${details.totalLines === 1 ? "" : "s"}`];
		if (details.exitCode !== undefined) parts.push(`exit ${details.exitCode}`);
		if (details.truncated) parts.push("output truncated");
		component.addChild(new Text(`\n${theme.fg("muted", parts.join(", "))}`, 0, 0));
	} else if (details?.containerCwd) {
		component.addChild(new Text(`\n${theme.fg("muted", `in ${details.containerCwd}`)}`, 0, 0));
	}

	if (state.startedAt !== undefined) {
		const end = state.endedAt ?? Date.now();
		const label = options.isPartial ? "Elapsed" : "Took";
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(end - state.startedAt)}`)}`, 0, 0));
	}
}

export function createDevcontainerRenderers() {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme, context: RenderArgs): Component {
			if (context.executionStarted && context.state.startedAt === undefined) {
				context.state.startedAt = Date.now();
				context.state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(commandText(args, theme));
			return text;
		},
		renderResult(
			result: AgentToolResult<DevcontainerDetails>,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: RenderArgs,
		): Component {
			const state = context.state;
			// While streaming there is no new output to show, so the elapsed
			// counter needs its own tick to keep moving.
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuild(component, result, options, state, theme);
			component.invalidate();
			return component;
		},
	};
}
