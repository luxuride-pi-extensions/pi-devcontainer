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
 * `bash -c '<command>'` string is asserted verbatim. That is where the
 * literal `cd '$HOME'` bug lived, and a unit test of the helper alone would
 * not have caught it.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asJsonObject, parseJsonc } from "./jsonc.js";
import { alreadyInContainer, loadDevcontainerJson } from "./config.js";
import { provisionContainer } from "./provision.js";
import { resolveToolCwd, runInContainer, settleBringUp } from "./run-in-container.js";
import { shq } from "./exec.js";
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

function checkTrue(name: string, cond: boolean) {
	checks++;
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name} (expected true)`);
	}
}

// --- jsonc -------------------------------------------------------------
check("strict JSON passes through", parseJsonc('{"a":1}'), { a: 1 });
check("line comments stripped", parseJsonc('{\n// hi\n"a":1}'), { a: 1 });
check("block comments stripped", parseJsonc('{/* x */"a":1}'), { a: 1 });
check("trailing comma in object", parseJsonc('{"a":1,}'), { a: 1 });
check("trailing comma in array", parseJsonc('{"a":[1,2,]}'), { a: [1, 2] });
// The regression this guards: a naive regex for trailing commas used to eat
// the comma AND the brace inside a string value, silently rewriting a command.
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
// string runInContainer built. Asserting that string verbatim is what
// catches quoting regressions such as the literal `cd '$HOME'`, and asserting
// the pair of returned paths is what keeps the two namespaces from blurring.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-bin-"));
	const realPath = process.env.PATH ?? "";
	// NOTE: projectCwd must be a REAL directory. runInContainer spawns with
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
			// failure. Bound every call so a regression reports which one it was.
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

		// THE REGRESSION GUARD: an empty cwd must never become `cd '$HOME'` or
		// any other invented directory — it is either the resolved mount or a
		// hard error.
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
	// SAFETY: settleBringUp only ever reads cfg.pendingUp. A real
	// DevcontainerConfig sits in exactly this state whenever the session is
	// outside a bring-up window, because pendingUp is optional and stays
	// unset. The cast avoids spelling out the required fields this test never
	// exercises, so a future field addition cannot break the test for no gain.
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

		// THE FIX: a changed feature set rebuilds the image and changes the
		// environment the commands run in, so it must invalidate the marker.
		// When the marker hashed only `provision`, this stayed at 1.
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

console.log(failures === 0 ? `\nALL ${checks} CHECKS PASSED` : `\n${failures}/${checks} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
