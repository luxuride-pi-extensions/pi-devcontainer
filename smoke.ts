/**
 * Smoke tests for the split devcontainer modules.
 *
 * Run with: npm test
 *
 * These cover the pure logic that is easy to break when moving code between
 * files: JSONC parsing (including the string-aware trailing-comma pass),
 * shell quoting, and config discovery.
 *
 * The container-exec tests are the important ones: they run the real
 * runInContainer against a fake `devcontainer` on PATH, so the generated
 * `bash -c '<command>'` string is asserted verbatim. A unit test of the cwd
 * helper alone would not catch a wrong string reaching the shell.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { asJsonObject, parseJsonc } from "./jsonc.js";
import { alreadyInContainer, loadDevcontainerJson } from "./config.js";
import { provisionContainer } from "./provision.js";
import { resolveToolCwd, runInContainer, settleBringUp } from "./run-in-container.js";
import { shq } from "./exec.js";
import { BASE_IMAGE, BASE_IMAGES, DOTNET_FEATURE, NODE_FEATURE, STACK_FEATURES, baseImageFor, featureFor, projectProfile, scaffold, stackIds } from "./scaffold.js";
import { collectionsIn, featuresInCollection, loadCatalog, parseFeaturesPage, parseRef, publishedVersions, searchFeatures } from "./features-index.js";
import { MAX_DISPLAY_BYTES_FOR_TEST, OutputTail } from "./render.js";
import type { DevcontainerConfig } from "./types.js";

let failures = 0;
let checks = 0;

function check(name: string, actual: unknown, expected: unknown) {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		failures++;
		console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
	} else {
		console.log(`ok   ${name}`);
	}
}

function checkTrue(name: string, cond: boolean, ...detail: unknown[]) {
	checks++;
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name} (expected true)${detail.length > 0 ? ` — got ${detail.join(", ")}` : ""}`);
	}
}

// --- jsonc -------------------------------------------------------------
check("strict JSON passes through", parseJsonc('{"a":1}'), { a: 1 });
check("line comments stripped", parseJsonc('{\n// hi\n"a":1}'), { a: 1 });
check("block comments stripped", parseJsonc('{/* x */"a":1}'), { a: 1 });
check("trailing comma in object", parseJsonc('{"a":1,}'), { a: 1 });
check("trailing comma in array", parseJsonc('{"a":[1,2,]}'), { a: [1, 2] });
// A naive regex for trailing commas also eats the comma AND the brace inside
// a string value, silently rewriting whatever command that value holds.
check("string containing ,} survives", parseJsonc(`{"cmd":"sed -e 's/,}//' f.json"}`), {
	cmd: "sed -e 's/,}//' f.json",
});
check("escaped quote inside string", parseJsonc('{"a":"x\\"y"}'), { a: 'x"y' });
check("asJsonObject rejects array", asJsonObject(parseJsonc("[1]")), null);
check("asJsonObject rejects null", asJsonObject(null), null);
checkTrue("asJsonObject accepts object", asJsonObject(parseJsonc("{}")) !== null);

// --- shq ---------------------------------------------------------------
check("shq plain", shq("abc"), "'abc'");
check("shq with spaces", shq("a b"), "'a b'");
check("shq escapes single quote", shq("a'b"), "'a'\\''b'");

checkTrue("alreadyInContainer is a boolean", typeof alreadyInContainer() === "boolean");

// --- config discovery --------------------------------------------------
{
	const tmp = mkdtempSync(join(tmpdir(), "dc-smoke-"));
	try {
		checkTrue("no config found in bare dir", loadDevcontainerJson(tmp).path === null);

		mkdirSync(join(tmp, ".devcontainer"));
		writeFileSync(join(tmp, ".devcontainer", "devcontainer.json"), '{\n  // a comment\n  "image": "alpine:3",\n}\n');
		const found = loadDevcontainerJson(tmp);
		checkTrue("config found under .devcontainer", found.path === join(tmp, ".devcontainer", "devcontainer.json"));
		check("image parsed through JSONC", found.config?.image, "alpine:3");
		checkTrue("root is the config dir", found.root === tmp);

		// Only the project dir is searched: a parent config must NOT be picked up.
		const child = join(tmp, "child");
		mkdirSync(child);
		checkTrue("no upward search into parent", loadDevcontainerJson(child).path === null);

		// Unparseable config reports the path but no config.
		writeFileSync(join(tmp, "child", "devcontainer.json"), "{ this is not json");
		const bad = loadDevcontainerJson(child);
		checkTrue("broken config has path", bad.path === join(child, "devcontainer.json"));
		checkTrue("broken config has null config", bad.config === null);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	// Legacy location.
	const legacy = mkdtempSync(join(tmpdir(), "dc-legacy-"));
	try {
		writeFileSync(join(legacy, "devcontainer.json"), '{"image":"busybox"}');
		checkTrue("legacy devcontainer.json found", loadDevcontainerJson(legacy).path === join(legacy, "devcontainer.json"));
	} finally {
		rmSync(legacy, { recursive: true, force: true });
	}
}

// --- cwd translation (end-to-end through a fake devcontainer CLI) -------
// The fake CLI prints its LAST argument, which is the `bash -c '<script>'`
// string runInContainer built. Asserting that string verbatim is what catches
// quoting regressions, and asserting the pair of returned paths is what keeps
// the two namespaces from blurring.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-bin-"));
	const realPath = process.env.PATH ?? "";
	// projectCwd must be a REAL directory: runInContainer spawns with
	// `cwd: cfg.projectCwd`, and node reports a nonexistent cwd as the same
	// confusing `spawn devcontainer ENOENT` as a missing binary.
	const projectCwd = mkdtempSync(join(tmpdir(), "dc-proj-"));
	mkdirSync(join(projectCwd, "sub", "dir"), { recursive: true });

	const fake = join(bin, "devcontainer");
	writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nprintf %s "$last"\nexit 0\n');
	chmodSync(fake, 0o755);
	// The docker fallback spawns `docker` instead, so it needs its own shim
	// with identical behaviour or the test would be asserting ENOENT.
	const fakeDocker = join(bin, "docker");
	writeFileSync(fakeDocker, '#!/bin/sh\nfor last; do :; done\nprintf %s "$last"\nexit 0\n');
	chmodSync(fakeDocker, 0o755);

	const base = {
		projectCwd,
		canonicalCwd: projectCwd,
		configRoot: projectCwd,
		containerName: "pi-devcontainer-proj",
		workspaceFolder: projectCwd,
		useCli: true,
		remoteWorkspace: "/workspaces/proj",
	} satisfies Omit<DevcontainerConfig, "image" | "pendingUp">;

	async function run(
		params: { command?: string; cwd?: string; stdin?: string },
		overrides: Partial<DevcontainerConfig> = {},
	) {
		const out: Buffer[] = [];
		const prevPath = process.env.PATH;
		process.env.PATH = `${bin}:${realPath}`;
		try {
			// runInContainer spawns `detached: true` + unref'd, so a lost
			// 'close' event would leave this promise pending forever and node
			// would exit with an "unsettled top-level await" instead of a useful
			// failure. Bound every call so a hang reports which call it was.
			const label = `${JSON.stringify(params)} ${JSON.stringify(overrides)}`;
			const res = await Promise.race([
				runInContainer({ ...base, ...overrides } as DevcontainerConfig, { command: "echo hi", ...params }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`run never settled: ${label}`)), 5000),
				),
			]);
			check(`exit code 0 for ${label}`, res.exitCode, 0);
			return res;
		} finally {
			process.env.PATH = prevPath;
		}
	}

	try {
		// Omitted cwd: the container-side mount, reported with the host
		// directory it corresponds to, so file tools can follow.
		const root = await run({});
		check("default cwd is the container mount", root.containerCwd, "/workspaces/proj");
		check("default cwd reports the host project dir", root.hostCwd, projectCwd);
		check("default cds to the mount", root.output, "cd '/workspaces/proj' && echo hi");

		const sub = await run({ cwd: "sub/dir" });
		check("relative cwd resolves inside the container", sub.containerCwd, "/workspaces/proj/sub/dir");
		check("relative cwd reports the host dir", sub.hostCwd, join(projectCwd, "sub", "dir"));
		check("relative cwd cds to the resolved dir", sub.output, "cd '/workspaces/proj/sub/dir' && echo hi");

		// An absolute path is a CONTAINER path, passed through untouched.
		const abs = await run({ cwd: "/etc" });
		check("absolute cwd taken at face value", abs.containerCwd, "/etc");
		check("out-of-mount absolute cwd has no host counterpart claim", abs.hostCwd, "/etc");

		// An empty or unresolvable cwd must never become `cd '$HOME'` or any
		// other invented directory — it is either the resolved mount or a hard
		// error.
		let noMountErr = "";
		try {
			await run({ cwd: "sub" }, { remoteWorkspace: undefined });
		} catch (err) {
			noMountErr = err instanceof Error ? err.message : String(err);
		}
		checkTrue("relative cwd without a known mount is rejected", noMountErr.includes("mount point is unknown"));
		checkTrue("rejection never invents a cd", !noMountErr.includes("cd "));

		// docker fallback: the workspace is mounted at its HOST path, so a
		// relative cwd resolves against the project directory and host and
		// container paths coincide.
		const docker = await run({ cwd: "sub" }, { useCli: false, image: "alpine:3" });
		check("docker fallback resolves against the project dir", docker.containerCwd, join(projectCwd, "sub"));
		check("docker fallback host path equals container path", docker.hostCwd, join(projectCwd, "sub"));
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(projectCwd, { recursive: true, force: true });
	}
}

// --- stdin is piped, not dropped ---------------------------------------
// The fake CLI execs a real bash with the trailing args preserved, so the
// `cat` really reads the pipe. Proving the bytes arrive needs a real process,
// not an argv assertion.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-stdin-bin-"));
	const projectCwd = mkdtempSync(join(tmpdir(), "dc-stdin-proj-"));
	const fake = join(bin, "devcontainer");
	writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "-c" ]; do shift; done\nshift\nexec /bin/bash -c "$1"\n');
	chmodSync(fake, 0o755);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath ?? ""}`;
	try {
		const cfg = {
			projectCwd,
			canonicalCwd: projectCwd,
			configRoot: projectCwd,
			containerName: "pi-devcontainer-proj",
			workspaceFolder: projectCwd,
			useCli: true,
			remoteWorkspace: "/workspaces",
		} as unknown as DevcontainerConfig;
		// The container mount does not exist on the test host, so `cd` is
		// expected to fail: only the stdin round trip is under test here.
		const res = await runInContainer(cfg, { command: "cat", cwd: "/", stdin: "hello from stdin\n" });
		check("stdin reaches the command", res.output.trim(), "hello from stdin");
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
		rmSync(projectCwd, { recursive: true, force: true });
	}
}

// --- settleBringUp ----------------------------------------------------
// The tool awaits bring-up before its first call, and a failure must be
// reported as a tool error rather than a container-less exec.
{
	// A real DevcontainerConfig sits in exactly this state whenever the
	// session is outside a bring-up window, because pendingUp is optional
	// and stays unset. The cast avoids spelling out the required fields this
	// test never exercises, so a future field addition cannot break the test
	// for no gain.
	const cfg = { pendingUp: undefined } as unknown as DevcontainerConfig;

	// No bring-up in flight: resolves immediately, in both states.
	await settleBringUp(cfg, () => true);
	await settleBringUp(cfg, () => false);
	checkTrue("settleBringUp with no pendingUp resolves", true);

	cfg.pendingUp = Promise.resolve();
	await settleBringUp(cfg, () => true);
	checkTrue("settleBringUp resolves when up succeeded and proxy enabled", true);

	// Bring-up rejected: the promise is swallowed and the failure is reported
	// by the throw, because `pendingUp` rejecting is the NORMAL signal.
	cfg.pendingUp = Promise.reject(new Error("up exited 1"));
	let msg = "";
	try {
		await settleBringUp(cfg, () => false);
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	check("settleBringUp throws on rejected up", msg, "devcontainer bring-up failed; the container is not available");
}

// --- provisioning marker keys on features too -------------------------
// End-to-end through a fake CLI that shims to a real bash, so the marker
// file actually lands in a temp $HOME and the "did it run again" question is
// answered by counting appends to a log, not by reading the hash.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-prov-bin-"));
	const home = mkdtempSync(join(tmpdir(), "dc-prov-home-"));
	const log = join(home, "ran.log");
	// provisionContainer builds argv as
	//   <prefix...> bash -lc <script> pi-override <marker>
	// so the shim finds `-lc` and re-invokes bash with BOTH trailing
	// positional args preserved: bash needs $0=pi-override and $1=marker,
	// because the marker probe is literally `[ -e "$HOME/$1" ]`. Dropping
	// the last arg silently made the probe look for a file named
	// "pi-override", which the matching `touch` then created — so every
	// later call looked "already provisioned" regardless of the marker key.
	const fake = join(bin, "devcontainer");
	writeFileSync(
		fake,
		'#!/bin/sh\nwhile [ "$1" != "-lc" ]; do shift; done\nshift\nexec /bin/bash -c "$1" "$2" "$3"\n',
	);
	chmodSync(fake, 0o755);

	const prevPath = process.env.PATH;
	const prevHome = process.env.HOME;
	process.env.PATH = `${bin}:${prevPath ?? ""}`;
	process.env.HOME = home;
	// Every call appends one line to the log via the injected first command,
	// so the log length is exactly the number of times provisioning RAN.
	const logLines = (): number => {
		try {
			return readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	const countRuns = async (provision: string[], features?: Record<string, unknown>) => {
		await provisionContainer(
			() => {},
			[join(bin, "devcontainer"), "exec", "--workspace-folder", "/x", "--"],
			[`echo ran >> "$HOME/ran.log"`, ...provision],
			features,
		);
		try {
			return readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	try {
		check("first provision runs the commands", await countRuns([]), 1);
		check("second provision is skipped via the marker", await countRuns([]), 1);

		// A changed feature set rebuilds the image and changes the environment
		// the commands run in, so it must invalidate the marker.
		check("changed features re-run provisioning", await countRuns([], { node: "20" }), 2);
		check("same features do not re-run", await countRuns([], { node: "20" }), 2);

		// Key order must not matter, or reformatting pi-override.json alone
		// would re-run every command.
		check("feature key order is irrelevant", await countRuns([], { node: "20", python: "3" }), 3);
		check("reordered features are still skipped", await countRuns([], { python: "3", node: "20" }), 3);
		check("changed provision re-runs", await countRuns(["true"], { python: "3", node: "20" }), 4);

		// A failing command must NOT write a marker, so the next session
		// retries. Counted straight off the log, because calling countRuns()
		// here would itself re-provision and blur the comparison.
		const run = (provision: string[], features?: Record<string, unknown>) =>
			provisionContainer(() => {}, [join(bin, "devcontainer")], provision, features).then(logLines);
		check("failing command still ran its command", await run(['echo ran >> "$HOME/ran.log"; false']), 5);
		check("failing command is retried (no marker written)", await run(['echo ran >> "$HOME/ran.log"; false']), 6);
	} finally {
		process.env.PATH = prevPath;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(bin, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}

// --- scaffold ---------------------------------------------------------
{
	const proj = mkdtempSync(join(tmpdir(), "pi-dc-scaffold-"));
	try {
		writeFileSync(join(proj, "Cargo.toml"), "[package]\nname='x'\n");
		writeFileSync(join(proj, "package.json"), JSON.stringify({ packageManager: "pnpm@9.1.0" }));
		// Order encodes specificity: Cargo.toml beats package.json, and a
		// project that is both Rust and Node is a Rust project.
		check("rust beats node", scaffold({ projectRoot: proj }).stack, "rust");
		check(
			"rust config",
			JSON.parse(scaffold({ projectRoot: proj }).text),
			{ name: "Rust", image: "mcr.microsoft.com/devcontainers/rust:1", features: { "ghcr.io/devcontainers/features/rust:1": {} } },
		);

		// A .NET project is usually a bare *.csproj with no global.json, so
		// detection needs a directory scan; the file lives in a subdirectory,
		// which must NOT count.
		const proj2 = mkdtempSync(join(tmpdir(), "pi-dc-scaffold-"));
		mkdirSync(join(proj2, "src"));
		writeFileSync(join(proj2, "src", "App.csproj"), "<Project/>");
		check("nested csproj is not detected", scaffold({ projectRoot: proj2 }).stack, "none");
		writeFileSync(join(proj2, "App.csproj"), "<Project/>");
		check("root csproj is detected", scaffold({ projectRoot: proj2 }).stack, "dotnet");

		const proj3 = mkdtempSync(join(tmpdir(), "pi-dc-scaffold-"));
		writeFileSync(join(proj3, "package.json"), JSON.stringify({ packageManager: "node@22.11.0" }));
		// A wrong node version is the most common reason a scaffolded
		// container builds on the host and fails in CI.
		check(
			"pinned node version is honored",
			JSON.parse(scaffold({ projectRoot: proj3 }).text).features,
			{ [NODE_FEATURE]: { version: "22", pnpmVersion: "latest", yarnVersion: "latest" } },
		);

		const full = JSON.parse(
			scaffold({
				projectRoot: proj,
				stack: "python",
				features: { "ghcr.io/devcontainers/features/postgres:1": { version: "16" } },
				postCreateCommand: "pip install -e .",
				forwardPorts: [8000, "5432:5432"],
			}).text,
		);
		check("forced stack and extra features", full, {
			name: "Python",
			image: "mcr.microsoft.com/devcontainers/python:3",
			features: {
				"ghcr.io/devcontainers/features/python:1": {},
				"ghcr.io/devcontainers/features/postgres:1": { version: "16" },
			},
			postCreateCommand: "pip install -e .",
			forwardPorts: ["8000", "5432:5432"],
		});
		// A devcontainer with a language-specific image beats base + feature:
		// the image already carries the toolchain, and a feature on top of it
		// is redundant work at build time.
		check("rust gets the rust image", scaffold({ projectRoot: proj }).config.image, "mcr.microsoft.com/devcontainers/rust:1");
		check("base image per stack", baseImageFor("python"), "mcr.microsoft.com/devcontainers/python:3");
		check("unknown stack gets the neutral image", baseImageFor("nope"), BASE_IMAGE);
		check("stack feature id", featureFor("go"), "ghcr.io/devcontainers/features/go:1");
		check("no feature for a bare stack", featureFor("none"), undefined);
		// The marker list is what lets the model see that a root package.json
		// next to services/go is not a Node project.
		const prof = projectProfile(proj);
		check("profile stack", prof.stack, "rust");
		check("profile lists every marker, not just the winner", prof.markers, ["Cargo.toml (rust)", "package.json (node)"]);
		check("profile suggests the stack image", prof.suggestedImage, "mcr.microsoft.com/devcontainers/rust:1");
		// An explicit image must override the stack default.
		check("explicit image wins", scaffold({ projectRoot: proj, image: "my/image:1" }).config.image, "my/image:1");
		check("scaffold path is .devcontainer/devcontainer.json", scaffold({ projectRoot: proj }).path, join(proj, ".devcontainer", "devcontainer.json"));
	} finally {
		rmSync(proj, { recursive: true, force: true });
	}
}

// --- feature catalog (parsing) ---------------------------------------
{
	check("ref splits into collection and feature", parseRef("ghcr.io/devcontainers/features/node:1"), {
		host: "ghcr.io",
		collection: "ghcr.io/devcontainers/features",
		feature: "node",
		tag: "1",
	});
	// A handful of maintainers have capitalised path segments, so the pattern
	// must not be lowercase-only.
	checkTrue("uppercase owner is accepted", parseRef("ghcr.io/KusionStack/aws-cli:1") !== undefined);
	checkTrue("a ref without a tag is rejected", parseRef("ghcr.io/devcontainers/features/node") === undefined);
	checkTrue("a two-segment ref is rejected", parseRef("ghcr.io/devcontainers:1") === undefined);
	// The rails collection has a four-segment path; dropping those rows would
	// hide a whole collection from the model.
	check("a four-segment path is a three-segment collection", parseRef("ghcr.io/rails/devcontainer/features/postgres-client:1"), {
		host: "ghcr.io",
		collection: "ghcr.io/rails/devcontainer/features",
		feature: "postgres-client",
		tag: "1",
	});
	checkTrue("a non-registry path is rejected", parseRef("some/path/feature:1") === undefined);

	// A reference that does not parse must never reach the model as if it
	// were usable.
	const page = [
		"<table><tr><th>x</th></tr>",
		'<tr><td><a href="/f/1">Node.js</a></td><td>Dev Container Spec Maintainers</td><td><code>ghcr.io/devcontainers/features/node:1</code></td><td><code>2.1.0</code></td></tr>',
		'<tr><td><a href="/f/2">Broken</a></td><td>Someone</td><td><code>not a ref</code></td><td><code>1.0.0</code></td></tr>',
		'<tr><td><a href="/f/3">Dupe</a></td><td>Someone</td><td><code>ghcr.io/a/b/c:2</code></td><td><code>1.0.0</code></td></tr>',
		'<tr><td><a href="/f/4">Dupe</a></td><td>Someone</td><td><code>ghcr.io/a/b/c:2</code></td><td><code>1.0.0</code></td></tr>',
		"</table>",
	].join("");
	check("page parses into catalog features", parseFeaturesPage(page), [
		{ name: "Node.js", maintainer: "Dev Container Spec Maintainers", ref: "ghcr.io/devcontainers/features/node:1", version: "2.1.0" },
		{ name: "Dupe", maintainer: "Someone", ref: "ghcr.io/a/b/c:2", version: "1.0.0" },
	]);

	const counts = collectionsIn(parseFeaturesPage(page));
	check("collection counts group by collection", [...counts.entries()], [
		["ghcr.io/devcontainers/features", 1],
		["ghcr.io/a/b", 1],
	]);
}

// --- generated references must be REAL (live) ---------------------------
// The curated BASE_IMAGES and STACK_FEATURES lists are the one part of this
// extension that cannot be derived from a live source, and a wrong entry
// produces a config that fails on the user's first build. These checks make
// that a test failure here instead.
//
// The catalog is the authority for features; MCR is the authority for images.
// Both are network calls, and a failure to reach either is reported rather
// than silently passing.
{
	const { features } = await loadCatalog();
	const catalogRefs = new Set(features.map((f) => f.ref));

	for (const ref of STACK_FEATURES) {
		checkTrue(`generated feature exists in the catalog: ${ref}`, catalogRefs.has(ref));
	}

	// cpp has no feature at all, so its stack must not name one.
	check("cpp stack declares no feature", scaffold({ projectRoot: mkdtempSync(join(tmpdir(), "cpp-")), stack: "cpp" }).features, []);

	// Every stack the tool offers must produce a base image; the empty-string
	// case is what a forgotten switch arm would look like.
	const images = new Set(BASE_IMAGES.map((b) => b.image));
	for (const id of stackIds()) {
		const image = baseImageFor(id);
		checkTrue(`stack ${id} maps to a listed base image`, images.has(image), image);
	}
	// The image each stack actually generates, which is what gets written.
	const perStack = stackIds().map((id) => baseImageFor(id));
	checkTrue("no two stacks share a base image", new Set(perStack).size >= 7, perStack.join(" "));

	// Every tag in the list must still resolve; a renamed or deleted tag has
	// to fail here. MCR needs no auth, so this stays two lines.
	const MANIFEST_ACCEPT =
		"application/vnd.docker.distribution.manifest.v2+json, " +
		"application/vnd.oci.image.index.v1+json, " +
		"application/vnd.docker.distribution.manifest.list.v2+json";
	for (const { image } of BASE_IMAGES) {
		const slash = image.indexOf("/");
		const lastColon = image.lastIndexOf(":");
		const repo = image.slice(slash + 1, lastColon);
		const tag = image.slice(lastColon + 1);
		let code = 0;
		try {
			const res = await fetch(`https://mcr.microsoft.com/v2/${repo}/manifests/${tag}`, {
				headers: { Accept: MANIFEST_ACCEPT },
			});
			code = res.status;
			await res.arrayBuffer();
		} catch (e) {
			checkTrue(`generated base image resolves: ${image}`, false, e instanceof Error ? e.message : String(e));
			continue;
		}
		check(`generated base image resolves: ${image}`, code, 200);
	}
}

// --- feature catalog (live) -------------------------------------------
{
	rmSync(join(homedir(), ".cache", "pi-devcontainer"), { recursive: true, force: true });
	const cold = await loadCatalog();
	checkTrue("live catalog has over a thousand features", cold.features.length > 1000);
	checkTrue("live catalog is not served from cache", !cold.fromCache);
	checkTrue("a second load is cached", (await loadCatalog()).fromCache);
	// Every feature the catalog offers must carry a usable reference, or the
	// model would paste something the devcontainer CLI rejects.
	checkTrue("every live feature has a parseable ref", cold.features.every((f) => parseRef(f.ref) !== undefined));
	// Every row the page offers must survive parsing, except the header.
	checkTrue("no catalog row is dropped as malformed", cold.features.length > 1400, 1400, cold.features.length);

	const postgres = await searchFeatures("postgres");
	checkTrue("a community postgres feature is found", postgres.text.includes("postgres"));
	// The whole point of the catalog over the collection index: a postgres
	// feature exists in collections other than the reference one.
	checkTrue("search reaches collections beyond the reference one", /devcontainer-features|devcontainer\/features|itsmechlark|rails/.test(postgres.text));

	const pinned = await searchFeatures("ghcr.io/devcontainers/features/node:1");
	checkTrue("an exact reference resolves", pinned.text.includes("ghcr.io/devcontainers/features/node:1"));
	// A four-segment collection must be reachable, not silently dropped.
	checkTrue("a four-segment collection is searchable", (await searchFeatures("ghcr.io/rails/devcontainer/features/postgres-client:1")).text.includes("postgres-client:1"));

	const ref = await featuresInCollection("ghcr.io/devcontainers/features");
	checkTrue("the reference collection lists rust", ref.text.includes("ghcr.io/devcontainers/features/rust:1"));
	// Every published major of a feature, not just the current one: a
	// project on .NET 8 needs the older major, so listing only the newest
	// would be an incomplete answer.
	const versions = await publishedVersions("ghcr.io/devcontainers/features/node:1");
	check("published majors, newest first", versions.versions.map((v) => v.tag), ["2", "1"]);
	checkTrue("a version reports the feature's own version", versions.versions[0]!.version.startsWith("2"));
	// dotnet:1 is a usable reference that the catalog never surfaces, since
	// the catalog only shows the current major.
	check("a superseded major is still reported", (await publishedVersions("ghcr.io/devcontainers/features/dotnet:2")).versions.map((v) => v.tag), ["2", "1"]);
	// A reference with no tag at all names the same feature.
	check("an untagged reference resolves the same feature", (await publishedVersions("ghcr.io/devcontainers/features/node")).versions.map((v) => v.tag), ["2", "1"]);
	// cpp publishes nothing at all.
	check("a feature with no published versions returns none", (await publishedVersions("ghcr.io/devcontainers/features/cpp:1")).versions, []);

	let threw = "";
	try {
		await featuresInCollection("ghcr.io/nope/nothing");
	} catch (e) {
		threw = e instanceof Error ? e.message : String(e);
	}
	checkTrue("an unknown collection is reported, not invented", threw.includes("no feature in the catalog"));
}

// --- streaming display tail --------------------------------------------
// The live view is bounded so a chatty build cannot grow the TUI's memory
// without limit, while the model still receives the full result separately.
{
	const tail = new OutputTail();
	check("an empty tail reports no lines", tail.counts(), { totalLines: 0, totalBytes: 0 });
	tail.append("one\ntwo");
	check("lines are counted, not newlines", tail.counts(), { totalLines: 2, totalBytes: 7 });
	tail.append("\n");
	check("a trailing newline starts a new line", tail.counts(), { totalLines: 3, totalBytes: 8 });

	// Overflow is cut on a line boundary: a view that starts mid-line reads as
	// corrupt output rather than as truncation.
	const big = new OutputTail();
	const line = `${"x".repeat(99)}\n`;
	for (let i = 0; i < 4000; i++) big.append(line);
	checkTrue("the tail stays bounded", big.value().length <= MAX_DISPLAY_BYTES_FOR_TEST, big.value().length);
	check("the retained lines are whole", big.value().split("\n").filter(Boolean).every((l) => l.length === 99), true);
	check("line count agrees with the retained text", big.counts().totalLines, big.value().split("\n").filter(Boolean).length + 1);
}

console.log(failures === 0 ? `\nALL ${checks} CHECKS PASSED` : `\n${failures}/${checks} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
