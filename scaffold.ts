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

/**
 * Maintained base images, offered to the model as a choice rather than
 * decided for it.
 *
 * The devcontainers site publishes an index of feature and template
 * COLLECTIONS, but no machine-readable catalog of base images, so this list
 * is curated and can lag. That is the right trade: an image name that has
 * gone away is caught immediately by the first build, whereas a hidden list
 * would leave the model inventing `node:20-slim` style tags that do not exist
 * for these images.
 *
 * Tags are chosen to be STABLE rather than newest. MCR publishes far more
 * versions than a generated config should assume — dotnet reaches 10.0,
 * java 25, typescript-node 26 — and defaulting every project to the newest
 * would silently build it against a runtime it was never tested with. Each
 * tag below is verified to resolve; the smoke tests re-check the ones that
 * are cheapest to check, so a removed tag fails there rather than on a user's
 * first build.
 */
export const BASE_IMAGES: { image: string; for: string }[] = [
	{ image: "mcr.microsoft.com/devcontainers/base:ubuntu", for: "nothing in particular; add features for what you need" },
	{ image: "mcr.microsoft.com/devcontainers/base:debian", for: "as above, on Debian" },
	{ image: "mcr.microsoft.com/devcontainers/base:alpine", for: "as above, on Alpine (musl — many wheels/binaries do not exist)" },
	{ image: "mcr.microsoft.com/devcontainers/universal:2", for: "multi-language: several runtimes in one image" },
	{ image: "mcr.microsoft.com/devcontainers/typescript-node:22", for: "Node + TypeScript" },
	{ image: "mcr.microsoft.com/devcontainers/python:3", for: "Python" },
	{ image: "mcr.microsoft.com/devcontainers/dotnet:8.0", for: ".NET" },
	{ image: "mcr.microsoft.com/devcontainers/java:21", for: "Java" },
	{ image: "mcr.microsoft.com/devcontainers/go:1.23", for: "Go" },
	{ image: "mcr.microsoft.com/devcontainers/php:8", for: "PHP" },
	{ image: "mcr.microsoft.com/devcontainers/ruby:3.3", for: "Ruby" },
	{ image: "mcr.microsoft.com/devcontainers/rust:1", for: "Rust" },
	{ image: "mcr.microsoft.com/devcontainers/cpp:3", for: "C++ (no cpp feature is published; the image carries the toolchain)" },
];

/** Base image suggested for a detected stack, or the neutral one. */
export function baseImageFor(stackId: string): string {
	switch (stackId) {
		case "node":
			return "mcr.microsoft.com/devcontainers/typescript-node:22";
		case "python":
			return "mcr.microsoft.com/devcontainers/python:3";
		case "dotnet":
			// MCR publishes no bare-major dotnet tags at all (dotnet:8 has
			// never existed; the line is 8.0), so the patch level is required.
			return "mcr.microsoft.com/devcontainers/dotnet:8.0";
		case "java":
			return "mcr.microsoft.com/devcontainers/java:21";
		case "go":
			return "mcr.microsoft.com/devcontainers/go:1.23";
		case "cpp":
			return "mcr.microsoft.com/devcontainers/cpp:3";
		case "rust":
			return "mcr.microsoft.com/devcontainers/rust:1";
		default:
			return BASE_IMAGE;
	}
}

/** The language feature id for a stack, if it has one. */
export function featureFor(stackId: string): string | undefined {
	return STACKS.find((s) => s.id === stackId)?.features[0];
}

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
	/** Base image, overriding the one implied by the stack. */
	image?: string;
	/** devcontainer name, overriding the one implied by the stack. */
	name?: string;
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
	/** The assembled config, so the model can see the key/value pairs. */
	config: Record<string, unknown>;
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

export const DOTNET_FEATURE = "ghcr.io/devcontainers/features/dotnet:2";
export const NODE_FEATURE = "ghcr.io/devcontainers/features/node:2";
/** Every feature the generated configs can name, for the catalog smoke check. */
export const STACK_FEATURES = [
	"ghcr.io/devcontainers/features/rust:1",
	DOTNET_FEATURE,
	"ghcr.io/devcontainers/features/python:1",
	"ghcr.io/devcontainers/features/go:1",
	NODE_FEATURE,
	"ghcr.io/devcontainers/features/java:1",
] as const;

const DOTNET: StackDef = {
	id: "dotnet",
	label: ".NET",
	// A .sln alongside project files is the common shape; a bare *.csproj is
	// matched by hasCsharpProject below, since globbing a directory is not
	// worth a dependency for one suffix check.
	markers: ["global.json", "Directory.Build.props"],
	features: [DOTNET_FEATURE],
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
		features: [NODE_FEATURE],
		featureOptions: {
			[NODE_FEATURE]: { version: "lts", pnpmVersion: "latest", yarnVersion: "latest" },
		},
	},
	{
		id: "cpp",
		label: "C++",
		markers: ["CMakeLists.txt", "meson.build", "conanfile.txt", "vcpkg.json"],
		// No feature: the reference collection publishes no `cpp` feature at
		// all, so declaring one would write a reference that cannot be
		// resolved. The language image carries the toolchain instead.
		features: [],
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
	if (stack.id === "node" && features[NODE_FEATURE]) {
		const pinned = nodeVersion(projectRoot);
		if (pinned) features[NODE_FEATURE]!.version = pinned;
	}
	// Caller-supplied features win over the detected ones, so a model can add
	// a database or a language the marker files did not reveal.
	for (const [id, opts] of Object.entries(options.features ?? {})) {
		features[id] = { ...(features[id] ?? {}), ...opts };
	}

	const config: Record<string, unknown> = {
		name: options.name ?? stack.label,
		image: options.image ?? baseImageFor(stack.id),
	};
	if (Object.keys(features).length > 0) config.features = features;
	if (options.postCreateCommand) config.postCreateCommand = options.postCreateCommand;
	if (options.forwardPorts && options.forwardPorts.length > 0) {
		config.forwardPorts = options.forwardPorts.map((p) => (typeof p === "number" ? String(p) : p));
	}

	const path = join(projectRoot, ".devcontainer", "devcontainer.json");
	return { text: renderConfig(config), path, stack: stack.id, features: Object.keys(features), config };
}

/** Stack ids offered in the tool description, for error messages. */
export function stackIds(): string[] {
	return [...STACKS.map((s) => s.id), STACK_NONE.id];
}

export interface ProjectProfile {
	/** Detected stack id, or "none". */
	stack: string;
	/** Marker files actually found in the project root, for the report. */
	markers: string[];
	/** Base image that fits the detected stack. */
	suggestedImage: string;
	/** Language feature id for the detected stack, if any. */
	suggestedFeature?: string;
	/** stack ids the model can force instead. */
	stackOptions: string[];
}

/**
 * Describe the project to the model so it can choose a base image and
 * features. The marker list is reported verbatim so a mixed or monorepo
 * project is visible: a root package.json next to services/go is not a Node
 * project, and the model can see why.
 */
export function projectProfile(projectRoot: string): ProjectProfile {
	const stack = detectStack(projectRoot);
	const markers = STACKS.flatMap((s) =>
		s.markers.filter((m) => existsSync(join(projectRoot, m))).map((m) => `${m} (${s.id})`),
	);
	if (hasCsharpProject(projectRoot)) markers.push("*.csproj (dotnet)");
	return {
		stack: stack.id,
		markers,
		suggestedImage: baseImageFor(stack.id),
		suggestedFeature: featureFor(stack.id),
		stackOptions: stackIds(),
	};
}
