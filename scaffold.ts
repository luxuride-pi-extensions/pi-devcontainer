/**
 * Scaffold a devcontainer.json for a project that has none.
 *
 * The generated config is deliberately image-based rather than
 * build-based: an `image` field needs no Dockerfile, no build context, and
 * works with the plain-docker fallback, while still getting the right
 * toolchain from a maintained devcontainers feature. A Dockerfile is the
 * right answer for system packages the image lacks — that is a follow-up
 * edit the model can make with the normal file tools, not something to
 * guess at from a stack sniff.
 *
 * Detection reads only the project root's own marker files. It never walks
 * up: a monorepo's root marker set is what defines the container, and a
 * stray parent package.json would otherwise pick the wrong stack.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Base image every generated config starts from. */
export const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:ubuntu";

export interface ScaffoldOptions {
	/** Root of the project being scaffolded. */
	projectRoot: string;
	/**
	 * Force a stack instead of detecting one. Accepts the same ids as
	 * detection, plus `none` for a plain base image with no language
	 * feature.
	 */
	stack?: string;
	/**
	 * Extra devcontainer features to merge in, as raw
	 * `ghcr.io/...` feature ids with optional option objects. The model
	 * supplies these when the project needs a tool the default set misses.
	 */
	features?: Record<string, Record<string, unknown>>;
	/** Shell commands to run once, after the container is created. */
	postCreateCommand?: string;
	/** Host ports to forward, e.g. `[3000]` or `["3000:3000"]`. */
	forwardPorts?: (number | string)[];
}

export interface Scaffold {
	/** JSONC text to write to .devcontainer/devcontainer.json. */
	text: string;
	/** Absolute path the config will occupy. */
	path: string;
	/** Detected or forced stack id, for the tool result. */
	stack: string;
	/** Feature ids written, so the model can see what it got. */
	features: string[];
}

/**
 * Stack definitions. `detect` runs top to bottom and the first match wins,
 * so order encodes specificity: a project with both Cargo.toml and
 * package.json is a Rust project that happens to build a web UI, not a
 * Node project.
 */
interface StackDef {
	id: string;
	/** Human label for the devcontainer `name` field. */
	label: string;
	/** Files whose presence in the project root means this stack. */
	markers: string[];
	/** Feature ids merged into `features`. Empty for a base-only image. */
	features: string[];
	/**
	 * Extra devcontainers.json keys. `pnpmVersion`/`yarnVersion` are set
	 * because the node feature installs those package managers by default
	 * and a project pinning one in `packageManager` fails confusingly
	 * otherwise.
	 */
	featureOptions?: Record<string, Record<string, unknown>>;
}

const DOTNET: StackDef = {
	id: "dotnet",
	label: ".NET",
	// A .sln alongside project files is the common shape; a bare *.csproj is
	// matched by hasCsharpProject below, since globbing a directory is not
	// worth a dependency for one suffix check.
	markers: ["global.json", "Directory.Build.props"],
	features: ["ghcr.io/devcontainers/features/dotnet:1"],
};

const STACKS: StackDef[] = [
	{
		id: "rust",
		label: "Rust",
		markers: ["Cargo.toml"],
		features: ["ghcr.io/devcontainers/features/rust:1"],
	},
	DOTNET,
	{
		id: "python",
		label: "Python",
		markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		features: ["ghcr.io/devcontainers/features/python:1"],
	},
	{
		id: "go",
		label: "Go",
		markers: ["go.mod", "go.work"],
		features: ["ghcr.io/devcontainers/features/go:1"],
	},
	{
		id: "node",
		label: "Node",
		markers: ["package.json"],
		features: ["ghcr.io/devcontainers/features/node:1"],
		featureOptions: {
			"ghcr.io/devcontainers/features/node:1": { version: "lts", pnpmVersion: "latest", yarnVersion: "latest" },
		},
	},
	{
		id: "cpp",
		label: "C++",
		markers: ["CMakeLists.txt", "meson.build", "conanfile.txt", "vcpkg.json"],
		features: ["ghcr.io/devcontainers/features/cpp:1"],
	},
	{
		id: "java",
		label: "Java",
		markers: ["pom.xml", "build.gradle", "build.gradle.kts", "gradlew"],
		features: ["ghcr.io/devcontainers/features/java:1"],
	},
];

/** A project with no recognised marker files: base image, no language feature. */
const STACK_NONE: StackDef = { id: "none", label: "Ubuntu", markers: [], features: [] };

/** First stack whose markers are present in the project root, or `none`. */
export function detectStack(projectRoot: string): StackDef {
	for (const stack of STACKS) {
		if (stack.markers.some((m) => existsSync(join(projectRoot, m)))) return stack;
	}
	// A .NET project is usually a bare *.csproj with no global.json, which
	// the marker list above cannot express without a directory scan. Checked
	// after the ordered list so a Rust project with a stray .csproj still
	// wins.
	if (hasCsharpProject(projectRoot)) return DOTNET;
	return STACK_NONE;
}

function hasCsharpProject(root: string): boolean {
	try {
		return readdirSync(root).some((f) => f.endsWith(".csproj") || f.endsWith(".fsproj"));
	} catch {
		return false;
	}
}

/**
 * Read `packageManager` / `engines` from a package.json so the generated
 * config asks for the version the project actually pins. A wrong version
 * is the most common reason a scaffolded container builds on the host and
 * fails in CI, so it is worth the read.
 */
function nodeVersion(projectRoot: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as {
			packageManager?: string;
			engines?: { node?: string };
		};
		const pinned = pkg.packageManager?.match(/^node@(\d+)/)?.[1];
		if (pinned) return pinned;
		return pkg.engines?.node?.match(/(\d+)/)?.[1];
	} catch {
		return undefined;
	}
}

/** Serialize with 2-space indent and tabs-free formatting; trailing newline. */
function renderConfig(config: Record<string, unknown>): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

export function scaffold(options: ScaffoldOptions): Scaffold {
	const { projectRoot } = options;
	const stack = options.stack ? (STACKS.find((s) => s.id === options.stack) ?? STACK_NONE) : detectStack(projectRoot);

	const features: Record<string, Record<string, unknown>> = {};
	for (const id of stack.features) {
		features[id] = stack.featureOptions?.[id] ?? {};
	}
	// A pinned node version beats the stack default: the project's own
	// packageManager field is the most authoritative signal available.
	if (stack.id === "node" && features["ghcr.io/devcontainers/features/node:1"]) {
		const pinned = nodeVersion(projectRoot);
		if (pinned) features["ghcr.io/devcontainers/features/node:1"]!.version = pinned;
	}
	// Caller-supplied features win over the detected ones, so a model can add
	// a database or a language the marker files did not reveal.
	for (const [id, opts] of Object.entries(options.features ?? {})) {
		features[id] = { ...(features[id] ?? {}), ...opts };
	}

	const config: Record<string, unknown> = {
		name: stack.label,
		image: BASE_IMAGE,
	};
	if (Object.keys(features).length > 0) config.features = features;
	if (options.postCreateCommand) config.postCreateCommand = options.postCreateCommand;
	if (options.forwardPorts && options.forwardPorts.length > 0) {
		config.forwardPorts = options.forwardPorts.map((p) => (typeof p === "number" ? String(p) : p));
	}

	const path = join(projectRoot, ".devcontainer", "devcontainer.json");
	return { text: renderConfig(config), path, stack: stack.id, features: Object.keys(features) };
}

/** Stack ids offered in the tool description, for error messages. */
export function stackIds(): string[] {
	return [...STACKS.map((s) => s.id), STACK_NONE.id];
}
