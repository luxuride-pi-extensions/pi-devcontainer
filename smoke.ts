/**
 * Smoke tests for the split devcontainer modules.
 *
 * Run with: npm test
 *
 * These cover the pure logic that is easy to break when moving code between
 * files: JSONC parsing (including the string-aware trailing-comma pass),
 * shell quoting, error classification, and config discovery.
 *
 * The cwd-translation tests are the important ones: they run the real
 * createContainerOps against a fake `devcontainer` on PATH, so the generated
 * `bash -lc '<command>'` string is asserted verbatim. That is where the
 * literal `cd '$HOME'` bug lived, and a unit test of the helper alone would
 * not have caught it.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asJsonObject, parseJsonc } from "./jsonc.js";
import { isProxyBreakError } from "./errors.js";
import { alreadyInContainer, loadDevcontainerJson } from "./config.js";
import { createContainerOps, settleBringUp } from "./container-ops.js";
import { provisionContainer } from "./provision.js";
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

// --- error classification ---------------------------------------------
checkTrue("non-zero exit is NOT a break", !isProxyBreakError(new Error("Command exited with code 1")));
checkTrue("timeout is NOT a break", !isProxyBreakError(new Error("timeout:30")));
checkTrue("abort is NOT a break", !isProxyBreakError(new Error("aborted")));
checkTrue("bring-up failure is NOT a break", !isProxyBreakError(new Error("devcontainer bring-up failed; proxy disabled")));
checkTrue("spawn failure IS a break", isProxyBreakError(new Error("spawn devcontainer ENOENT")));

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
// The fake CLI prints its LAST argument, which is the `bash -lc '<script>'`
// string createContainerOps built. Asserting that string verbatim is what
// catches quoting regressions such as the literal `cd '$HOME'`.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-bin-"));
	const realPath = process.env.PATH ?? "";
	// NOTE: projectCwd must be a REAL directory. createContainerOps spawns with
	// `cwd: cfg.projectCwd`, and node reports a nonexistent cwd as the same
	// confusing `spawn devcontainer ENOENT` as a missing binary.
	const projectCwd = mkdtempSync(join(tmpdir(), "dc-proj-"));
	const outsideCwd = mkdtempSync(join(tmpdir(), "dc-outside-"));
	mkdirSync(join(projectCwd, "sub", "dir"), { recursive: true });

	const fake = join(bin, "devcontainer");
	writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nprintf %s "$last"\nexit 0\n');
	chmodSync(fake, 0o755);

	const base = {
		projectCwd,
		canonicalCwd: projectCwd,
		configRoot: projectCwd,
		containerName: "pi-devcontainer-proj",
		workspaceFolder: projectCwd,
		useCli: true,
		remoteWorkspace: "/workspaces/proj",
	} satisfies Omit<DevcontainerConfig, "image" | "pendingUp">;

	async function innerFor(cwd: string, overrides: Partial<DevcontainerConfig> = {}, env: NodeJS.ProcessEnv = {}) {
		const warned: string[] = [];
		const ops = createContainerOps({ ...base, ...overrides } as DevcontainerConfig, () => true, (w) =>
			warned.push(w),
		);
		const out: Buffer[] = [];
		const prevPath = process.env.PATH;
		process.env.PATH = `${bin}:${realPath}`;
		try {
			// createContainerOps spawns `detached: true` + unref'd, so a lost
			// 'close' event would leave this promise pending forever and node
			// would exit with an "unsettled top-level await" instead of a useful
			// failure. Bound every call so a regression reports which one it was.
			const label = `cwd ${cwd} ${JSON.stringify(overrides)}`;
			const res = await Promise.race([
				ops.exec("echo hi", cwd, { onData: (d) => out.push(Buffer.from(d)), env }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`exec never settled: ${label}`)), 5000),
				),
			]);
			check(`exit code 0 for ${label}`, res.exitCode, 0);
		} finally {
			process.env.PATH = prevPath;
		}
		return { script: Buffer.concat(out).toString(), warned };
	}

	try {
		const root = await innerFor(projectCwd);
		check(
			"project cwd cds to the mount",
			root.script.includes(`cd '/workspaces/proj' && echo hi`),
			true,
		);
		checkTrue("project cwd emits PI_HOST_CWD", root.script.includes("PI_HOST_CWD='"));
		checkTrue("project cwd emits PI_DEVCONTAINER_WORKSPACE", root.script.includes("PI_DEVCONTAINER_WORKSPACE='/workspaces/proj'"));
		check("no warning for in-mount cwd", root.warned.length, 0);

		const sub = await innerFor(join(projectCwd, "sub", "dir"));
		check(
			"subdirectory is appended to the mount",
			sub.script.includes("cd '/workspaces/proj/sub/dir' && echo hi"),
			true,
		);
		check("no warning for in-mount subdir", sub.warned.length, 0);

		// A host path that does not exist in the container must be re-based
		// onto the mount root and reported, not passed through.
		const outside = await innerFor(outsideCwd);
		check("outside cwd re-based onto mount root", outside.script.includes("cd '/workspaces/proj' && echo hi"), true);
		check("outside cwd warns once", outside.warned, [outsideCwd]);

		// THE REGRESSION GUARD: with no resolved mount point the extension
		// must emit no `cd` at all. It used to emit `cd '$HOME'`, which bash
		// treated as a literal directory and failed on every command.
		const noMount = await innerFor(projectCwd, { remoteWorkspace: undefined });
		checkTrue("no mount point emits no cd", !noMount.script.includes("cd "));
		checkTrue("no mount point still exports PI_HOST_CWD", noMount.script.includes("PI_HOST_CWD='"));
		checkTrue(
			"no mount point omits PI_DEVCONTAINER_WORKSPACE",
			!noMount.script.includes("PI_DEVCONTAINER_WORKSPACE"),
		);
		checkTrue("no literal $HOME cd", !noMount.script.includes("$HOME"));

		// PI_* env from the tool is forwarded; other host env is not.
		const envTest = await innerFor(projectCwd, {}, { PI_SESSION_ID: "abc", HOME: "/home/lux", PATH: "/usr/bin" });
		checkTrue("PI_ env forwarded", envTest.script.includes("PI_SESSION_ID='abc'"));
		checkTrue("host HOME not leaked", !envTest.script.includes("/home/lux'"));
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(projectCwd, { recursive: true, force: true });
		rmSync(outsideCwd, { recursive: true, force: true });
	}
}

// --- settleBringUp ----------------------------------------------------
// Both command paths share one implementation, so the failure classification
// cannot drift: the bash tool falls back to the LOCAL shell on failure, while
// `!`/`!!` user bash reaches exec directly and must throw instead.
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
	check("settleBringUp throws on rejected up", msg, "devcontainer bring-up failed; proxy disabled");
	checkTrue("bring-up throw is classified non-breaking", !isProxyBreakError(new Error(msg)));
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
