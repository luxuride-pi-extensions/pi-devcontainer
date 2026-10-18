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
import { containerAlive, resolveToolCwd, runInContainer, settleBringUp } from "./run-in-container.js";
import { BringUpLog, describePhase, startProgressWidget } from "./progress.js";
import { DEFAULT_RUN_TIMEOUT, shq, run } from "./exec.js";
import { DOCKER_IN_DOCKER_FEATURE, DOCKER_OUTSIDE_OF_DOCKER_FEATURE, BASE_IMAGE, BASE_IMAGES, DOTNET_FEATURE, NODE_FEATURE, STACK_FEATURES, baseImageFor, describeDockerAccess, featureFor, projectProfile, scaffold, stackIds } from "./scaffold.js";
import type { Scaffold } from "./scaffold.js";
import { collectionsIn, featuresInCollection, loadCatalog, parseFeaturesPage, parseRef, publishedVersions, searchFeatures } from "./features-index.js";
import { MAX_DISPLAY_BYTES_FOR_TEST, OutputTail } from "./render.js";
import { parseListeningPorts, parseSocatListenPort, socatArgs } from "./ports.js";
import { truncateTail } from "@earendil-works/pi-coding-agent";
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

// --- bounded run -------------------------------------------------------
// A docker daemon wedged mid-request answers nothing and never exits, so an
// unbounded run() would freeze ensureReady with nothing on screen. The cap
// must kill the child and reject with a message naming the command.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-runto-bin-"));
	const slow = join(bin, "slowcmd");
	writeFileSync(slow, "#!/bin/sh\necho started\nsleep 30\n");
	chmodSync(slow, 0o755);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath ?? ""}`;
	try {
		const t0 = Date.now();
		let err = "";
		try {
			await run("slowcmd", [], undefined, 1);
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
		const elapsed = Date.now() - t0;
		checkTrue("a hung command is rejected by the cap", err.includes("timed out after 1s"), err);
		check("the message names the command", err, "host command 'slowcmd' timed out after 1s with no output or exit");
		checkTrue("the kill happens at the cap, not after the sleep", elapsed < 5000, elapsed);

		// The default cap exists and is sane — a constant typed wrongly would
		// silently change every bounded call's budget.
		check("the default cap is 60 seconds", DEFAULT_RUN_TIMEOUT, 60);

		// Output produced BEFORE the cap still reaches onData: the caller's
		// progress stream is fed up to the kill.
		const seen: string[] = [];
		try {
			await run("slowcmd", [], (d) => seen.push(d.toString().trim()), 1);
		} catch {
			// expected
		}
		check("output before the kill reaches onData", seen.join("|"), "started");

		// timeoutSeconds = 0 disables the cap: the sleep finishes and the
		// exit code still arrives. This is what bring-up passes.
		const uncapped = await run("slowcmd", [], undefined, 0);
		check("timeout 0 means no cap", uncapped.code, 0);

		// A fast command resolves normally with the cap in place.
		writeFileSync(slow, "#!/bin/sh\necho done\n");
		const fast = await run("slowcmd", []);
		check("a fast command still resolves", fast.code, 0);
		check("its stdout arrives", fast.stdout.trim(), "done");
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
	}
}

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
		checkTrue("root is the searched directory", found.root === tmp);
		checkTrue("the default location is not named", found.multi === null);

		// The parent chain is searched when the project dir has no config of
		// its own. `root` stays the searched directory — the workspace the
		// container should mount — not the directory that holds the config;
		// the caller passes --config to the CLI when the file is elsewhere.
		const child = join(tmp, "child");
		mkdirSync(child);
		const fromChild = loadDevcontainerJson(child);
		checkTrue("config found in the parent directory", fromChild.path === join(tmp, ".devcontainer", "devcontainer.json"));
		checkTrue("a parent config's root is the child", fromChild.root === child);
		checkTrue("a parent config reports its own configDir", fromChild.configDir === join(tmp, ".devcontainer"));
		checkTrue("a parent config is not named", fromChild.multi === null);

		// Named subdirectory configs: the first sorted name wins, and the
		// winner is reported so several configs can be told apart.
		mkdirSync(join(tmp, "child", ".devcontainer", "java-8"), { recursive: true });
		mkdirSync(join(tmp, "child", ".devcontainer", "java-17"), { recursive: true });
		writeFileSync(join(tmp, "child", ".devcontainer", "java-17", "devcontainer.json"), '{"image":"mcr.microsoft.com/devcontainers/java:17"}');
		writeFileSync(join(tmp, "child", ".devcontainer", "java-8", "devcontainer.json"), '{"image":"mcr.microsoft.com/devcontainers/java:8"}');
		const named = loadDevcontainerJson(child);
		checkTrue("a named config beats the parent's config", named.path === join(child, ".devcontainer", "java-17", "devcontainer.json"));
		checkTrue("the named config is reported", named.multi === "java-17");
		check("the named config's image parses", named.config?.image, "mcr.microsoft.com/devcontainers/java:17");
		checkTrue("a named config's root is still the searched dir", named.root === child);
		checkTrue("a named config's configDir is its own directory", named.configDir === join(child, ".devcontainer", "java-17"));
		checkTrue("the default location beats named configs", loadDevcontainerJson(tmp).path === join(tmp, ".devcontainer", "devcontainer.json"));

		// A directory without a config whose parents have none either finds
		// nothing, without walking forever at the filesystem root.
		const bare = mkdtempSync(join(tmpdir(), "dc-bare-"));
		try {
			checkTrue("no config found in a bare temp tree", loadDevcontainerJson(join(bare, "a", "b")).path === null);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}

		// Unparseable config reports the path but no config. A fresh dir:
		// the named configs above would shadow a bare file in `child`.
		const badDir = mkdtempSync(join(tmpdir(), "dc-bad-"));
		try {
			writeFileSync(join(badDir, "devcontainer.json"), "{ this is not json");
			const bad = loadDevcontainerJson(badDir);
			checkTrue("broken config has path", bad.path === join(badDir, "devcontainer.json"));
			checkTrue("broken config has null config", bad.config === null);
		} finally {
			rmSync(badDir, { recursive: true, force: true });
		}
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
		configPath: join(projectCwd, ".devcontainer", "devcontainer.json"),
		configDefaulted: true,
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

// --- container liveness ------------------------------------------------
// A container that dies AFTER its bring-up settled (docker restart, docker
// rm, OOM) sails through a spent pendingUp and fails at exec with "no such
// container". containerAlive is what the run tool probes before deciding to
// re-up, so a false "alive" here would make the recovery a no-op.
{
	const bin = mkdtempSync(join(tmpdir(), "dc-alive-bin-"));
	const fake = join(bin, "docker");
	writeFileSync(fake, "#!/bin/sh\necho running\n");
	chmodSync(fake, 0o755);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath ?? ""}`;
	try {
		// CLI mode: the container is found by its label, not by a name this
		// extension invented — the fake docker answers `docker ps` with the
		// CLI's own name for it, then `docker inspect` with its state.
		writeFileSync(fake, '#!/bin/sh\n[ "$1" = "ps" ] && { echo vhn-proj; exit 0; }\necho running\n');
		const cliCfg = {
			projectCwd: "/p",
			configRoot: "/p",
			containerName: "pi-devcontainer-proj",
			useCli: true,
		} as unknown as Parameters<typeof containerAlive>[0];
		const up = await containerAlive(cliCfg);
		checkTrue("a running CLI container is alive", up.alive);
		check("the CLI container's name is the label match", up.containerName, "vhn-proj");

		// Docker fallback: the container is the one this extension created.
		const dockerCfg = {
			projectCwd: "/p",
			configRoot: "/p",
			containerName: "pi-devcontainer-proj",
			useCli: false,
		} as unknown as Parameters<typeof containerAlive>[0];
		const running = await containerAlive(dockerCfg);
		checkTrue("a running docker-fallback container is alive", running.alive);
		check("its name is the config's", running.containerName, "pi-devcontainer-proj");

		// A docker that errors (daemon gone) is dead, not a crash.
		writeFileSync(fake, "#!/bin/sh\necho Cannot connect to the Docker daemon >&2\nexit 1\n");
		const daemonDown = await containerAlive(dockerCfg);
		checkTrue("an unreachable docker reports not alive", !daemonDown.alive);
		checkTrue("an unreachable docker still names the container", daemonDown.containerName === "pi-devcontainer-proj");

		// A container that exists but is not running (docker rm -s / OOM kill).
		writeFileSync(fake, '#!/bin/sh\n[ "$1" = "inspect" ] && { echo exited; exit 0; }\necho proj\n');
		const stopped = await containerAlive(cliCfg);
		checkTrue("an exited container is not alive", !stopped.alive);
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
	}

	// Source shape: the recovery fires only on exec's container errors and
	// re-runs bringUp once, with the settle awaiter re-reading the fresh cfg.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	checkTrue("the re-up probe exists", source.includes("containerAlive(before)"), "probe");
	checkTrue(
		"the recovery matches both exec failure spellings",
		/no such container\|is not running/i.test(source),
		"match",
	);
	checkTrue("a live container never re-ups", source.includes("if (alive.alive) return false;"), "no re-up");
	checkTrue("a bring-up in flight never re-ups", source.includes("if (bringUpInFlight) return false;"), "in-flight");
	checkTrue("the re-up re-reads the fresh config", source.includes("if (!fresh || fresh === before"), "fresh");
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

// --- output truncation -------------------------------------------------
// The cap applies to what the MODEL receives, and the truncation note has to
// survive alongside the kept lines, or a short result looks like a short
// command.
{
	const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
	const all = truncateTail(lines);
	check("no cap keeps every line", all.truncated, false);

	const capped = truncateTail(lines, { maxLines: 5 });
	check("the cap keeps the last N lines", capped.content.split("\n").map((l) => l.trim()), ["line 36", "line 37", "line 38", "line 39", "line 40"]);
	check("the cap reports the original size", capped.totalLines, 40);
	check("the cap reports what it kept", capped.outputLines, 5);
	check("a cap looser than the output is not truncation", truncateTail(lines, { maxLines: 5000 }).truncated, false);
	check("a single line is kept whole", truncateTail("only", { maxLines: 1 }).content, "only");
	check("the kept lines are not indented or padded", capped.content.split("\n")[0], "line 36");
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
	await settleBringUp(cfg, { isEnabled: () => true });
	await settleBringUp(cfg, { isEnabled: () => false });
	checkTrue("settleBringUp with no pendingUp resolves", true);

	cfg.pendingUp = Promise.resolve();
	await settleBringUp(cfg, { isEnabled: () => true });
	checkTrue("settleBringUp resolves when up succeeded and proxy enabled", true);

	// Bring-up rejected: the reason is reported, not swallowed, because the
	// model otherwise sees a bare "bring-up failed" and cannot act on it.
	cfg.pendingUp = Promise.reject(new Error("up exited 1"));
	let msg = "";
	try {
		await settleBringUp(cfg, { isEnabled: () => true });
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	checkTrue("settleBringUp reports the bring-up reason", msg.includes("up exited 1"), msg);
}

// --- a still-running bring-up: streamed, re-waitable, capped on request ---
// The blank-row hang this fixes: an unbounded await over a multi-minute image
// pull. The default has no cap — the call waits until bring-up settles, with
// the pull output streaming out while waiting — and a caller that passes a
// waitBudgetSeconds cap gets the bounded behavior back instead.
{
	const log = new BringUpLog();
	log.append("Pulling mcr.microsoft.com/devcontainers/dotnet:8.0\n");
	log.append("abc123: Download complete\n");
	let never = false;
	const cfg = {
		// Pending on purpose: resolves only if someone outside this test does.
		pendingUp: new Promise<void>(() => {}),
		bringUpLog: log,
		projectCwd: "/proj",
	} as unknown as DevcontainerConfig;

	const seen: string[] = [];
	let msg = "";
	const started = Date.now();
	try {
		await settleBringUp(cfg, { isEnabled: () => true, onProgress: (l) => seen.push(l), waitBudgetSeconds: 0.3 });
		never = true;
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	checkTrue("a pending bring-up does not hang the call", !never);
	checkTrue("the wait is bounded by its budget", Date.now() - started < 5000, Date.now() - started);
	checkTrue("the report says it is still running, not failed", msg.includes("still being created"), msg);
	checkTrue("the report is not a failure verdict", !msg.includes("bring-up failed"), msg);
	checkTrue("the report says how to keep waiting", msg.includes("waitForContainer"), msg);

	// No budget means no cap: the call waits for the bring-up itself. It must
	// still be abortable — a cancel has to end the wait even without a cap —
	// and the pull output must reach onProgress while it waits.
	{
		const abort = new AbortController();
		const seenUnbounded: string[] = [];
		let abortedMsg = "";
		const unbounded = settleBringUp(cfg, {
			isEnabled: () => true,
			onProgress: (l) => seenUnbounded.push(l),
			signal: abort.signal,
		});
		setTimeout(() => abort.abort(), 150);
		try {
			await unbounded;
		} catch (err) {
			abortedMsg = err instanceof Error ? err.message : String(err);
		}
		checkTrue("an uncapped wait ends when the caller aborts", abortedMsg.includes("aborted"), abortedMsg);
		checkTrue("the uncapped wait streams progress while waiting", seenUnbounded.length > 0, seenUnbounded.length);
	}

	// An uncapped wait over a bring-up that DOES settle resolves rather than
	// reporting "still being created" — the cap is the only thing that can
	// cut the wait short.
	{
		const settling = {
			pendingUp: new Promise<void>((res) => setTimeout(res, 100)),
			bringUpLog: log,
			projectCwd: "/proj",
		} as unknown as DevcontainerConfig;
		let settled = false;
		let err2 = "";
		try {
			await settleBringUp(settling, { isEnabled: () => true });
			settled = true;
		} catch (e) {
			err2 = e instanceof Error ? e.message : String(e);
		}
		checkTrue("an uncapped wait over a settling bring-up resolves", settled, err2);
	}
	checkTrue("the report says it is still running, not failed", msg.includes("still being created"), msg);
	checkTrue("the report is not a failure verdict", !msg.includes("bring-up failed"), msg);
	checkTrue("the report says how to keep waiting", msg.includes("waitForContainer"), msg);
	// The streamed lines include what the log already held, so a caller that
	// subscribes late still sees the pull that happened before it started.
	check("progress already in the log is replayed", seen, [
		"Pulling mcr.microsoft.com/devcontainers/dotnet:8.0\n",
		"abc123: Download complete\n",
	]);
	checkTrue("the report carries the pull output", msg.includes("abc123: Download complete"), msg);

	// A line arriving after the give-up is still logged, and a later call
	// with a bigger budget keeps waiting rather than starting over.
	log.append("def456: Extracting\n");
	const seen2: string[] = [];
	let stillPending = false;
	const cfg2 = {
		pendingUp: new Promise<void>((res) => setTimeout(res, 200)),
		bringUpLog: log,
		projectCwd: "/proj",
	} as unknown as DevcontainerConfig;
	await settleBringUp(cfg2, { isEnabled: () => true, onProgress: (l) => seen2.push(l), waitBudgetSeconds: 10 }).then(
		() => (stillPending = false),
		() => (stillPending = true),
	);
	checkTrue("a later call with a bigger budget completes", !stillPending);
	checkTrue("the later call saw the earlier output plus its own", seen2.length >= 3, seen2.length);
}

// --- bring-up progress log --------------------------------------------
// A pull's progress frames arrive as CR-terminated text, and a frame that
// arrives without a newline must not be held back forever.
{
	const log = new BringUpLog();
	const seen: string[] = [];
	log.subscribe((l) => seen.push(l));
	// Mid-line chunk: the first half must not surface until the line closes.
	log.append("half a ");
	check("a partial line is not emitted yet", seen, []);
	log.append("line\n");
	check("the completed line is emitted", seen, ["half a line\n"]);

	// Docker's pull progress uses bare CRs.
	log.append("one\rtwo\r");
	check("CR frames are separate lines", seen.slice(1), ["one\n", "two\n"]);

	// Blank padding between frames would crowd out real progress.
	log.append("\n\n");
	log.append("kept\n");
	checkTrue("blank lines are dropped", !seen.includes("\n"));

	// A last frame with no trailing newline is still reported by snapshot,
	// which is what the give-up message reads.
	log.append("tail without newline");
	check("snapshot includes the unterminated tail", log.snapshot().endsWith("tail without newline"), true);

	// Retention is bounded: a long pull must not grow the TUI without limit.
	for (let i = 0; i < 1000; i++) log.append(`frame ${i}\n`);
	checkTrue("retained lines are bounded", log.snapshot().split("\n").length <= 200, log.snapshot().split("\n").length);
	checkTrue("the newest line survives the bound", log.snapshot().includes("frame 999"));
	checkTrue("the oldest line is dropped", !log.snapshot().includes("frame 1\n"));
}

// --- the display tail can be handed over ------------------------------
// The row shows pull progress during bring-up and then the command's own
// output, so the tail has to be able to start over without being replaced.
{
	const tail = new OutputTail();
	tail.append("pull progress\n");
	check("the tail holds what was appended", tail.value(), "pull progress\n");
	tail.reset();
	check("reset empties the tail", tail.value(), "");
	check("reset zeroes the counts", tail.counts(), { totalLines: 0, totalBytes: 0 });
	tail.append("command output\n");
	check("the tail accepts new output after a reset", tail.value(), "command output\n");
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
			// A Rust project is scaffolded with the host Docker socket shared
			// by default, so the expected config carries the mount.
			"rust config",
			JSON.parse(scaffold({ projectRoot: proj }).text),
			{
				name: "Rust",
				image: "mcr.microsoft.com/devcontainers/rust:1",
				features: {
					"ghcr.io/devcontainers/features/rust:1": {},
				},
				mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" }],
			},
		);
		checkTrue("the default scaffold shares the host docker socket", scaffold({ projectRoot: proj }).config.mounts !== undefined);

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
			mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" }],
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
	check(
		"cpp stack declares no feature",
		scaffold({ projectRoot: mkdtempSync(join(tmpdir(), "cpp-")), stack: "cpp", shareHostDocker: false }).features,
		[],
	);

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


// --- the phase a user is shown ----------------------------------------
// A status bar that says "working" for four minutes tells the user nothing;
// the phase is what distinguishes a healthy pull from a stuck one.
{
	check("an empty log names the whole job", describePhase([]), "pulling and building the devcontainer image");
	check("a pull in progress is a download", describePhase(["abc123: Downloading 41.2 MB/120 MB"]), "downloading image layers");
	check("a pull in progress can also be a layer fetch", describePhase(["Pulling fs layer 1a2b3c"]), "downloading image layers");
	check("a finished download is not a finished pull", describePhase(["abc123: Download complete"]), "downloading image layers");
	check("download done and extracting is the extract phase", describePhase(["abc123: Download complete", "abc123: Extracting 88.4 MB/88.4 MB"]), "extracting downloaded layers");
	check("extracting alone is the extract phase", describePhase(["abc123: Extracting 10 MB/88 MB"]), "extracting image layers");
	// Order matters: a log holds several of these at once, and the most
	// specific one is the one that is actually happening.
	check("a complete pull outranks a stale download line", describePhase(["abc123: Downloading 1 MB/2 MB", "Pull complete"]), "image pulled");
	check("extracting outranks an earlier completed download", describePhase(["abc123: Download complete", "abc123: Extracting 88.4 MB/88.4 MB"]), "extracting downloaded layers");
	check("a fresh image is a finished pull", describePhase(["Status: Downloaded newer image for mcr.microsoft.com/devcontainers/dotnet:8.0"]), "image pulled");
	check("naming to means the image is being built", describePhase(["#8 naming to docker.io/library/pi-devcontainer"]), "building image from the devcontainer config");
	check("buildkit means the image is being built", describePhase(["#7 [2/3] RUN /bin/sh -c apt-get update"]), "building image from the devcontainer config");
	check("a feature is being installed", describePhase(["[Features] Installing feature ghcr.io/devcontainers/features/docker-in-docker:4"]), "installing devcontainer features");
	check("a created container is reported", describePhase(["[2/3] Creating container"]), "creating the container");
	check("a started container is reported", describePhase(["[3/4] Starting container"]), "container starting");
	check("a completed run is the last step", describePhase(["[3/4] Starting container", "Completed"]), "container starting");
	// buildx prints "Running" for an ordinary build step, and a feature's apt
	// run must not read as a container that has finished starting.
	check("a build step is not a started container", describePhase(["#17 0.329 Running apt-get update..."]), "building image from the devcontainer config");
	// Most-specific-first must survive a log that already advanced.
	// The buildx pull a feature build does, which is the slow part of a real
	// first run: byte counters, and `done` on the lines that have finished.
	check("a live buildx byte counter is a download", describePhase(["#4 sha256:ab 12.3MB / 221.26MB 41.2s"]), "downloading image layers");
	check("a finished buildx byte counter is not a live download", describePhase(["#4 sha256:ab 221.26MB / 221.26MB 1216.8s done"]), "pulling and building the devcontainer image");
	check("a live counter outranks a finished one", describePhase(["#4 sha256:ab 221.26MB / 221.26MB 1216.8s done", "#4 sha256:cd 1.0MB / 43.51MB 2.0s"]), "downloading image layers");
	// A later step is not masked by an earlier one: describePhase(["abc123: Extracting 1 MB/2 MB", "Pull complete", "naming to x", "[Features] installing"]), "installing devcontainer features");
	// Same test one stage earlier: the build line must not win over the
	// feature install that follows it.
	check("a build is not masked by a later container step", describePhase(["naming to x", "[2/3] Creating container"]), "creating the container");
}

// --- the status bar during bring-up -----------------------------------
// The user asked to see the pull. The tool row cannot render it (the wait
// happens before the first output), so the status bar is the channel.
{
	const log = new BringUpLog();
	const statuses: (string | undefined)[] = [];
	const working: (string | undefined)[] = [];
	const stop = startProgressWidget(
		{ setStatus: (_k, t) => statuses.push(t), setWorkingMessage: (m) => working.push(m) },
		log,
		"/proj",
	);
	// Immediately, not only on the timer: the first tick is what the user
	// sees during a wait that ends in a couple of seconds.
	checkTrue("the status is set before the first tick elapses", statuses.length === 1, statuses.length);
	checkTrue("the status names the project", statuses[0]?.includes("/proj") === true, statuses[0]);
	checkTrue("the status shows elapsed seconds", /⏳ devcontainer \d+s — /.test(statuses[0] ?? "") === true, statuses[0]);
	checkTrue("the working message names the project", working[0]?.includes("/proj") === true, working[0]);

	// The newest moving line is shown, because a changing percentage is the
	// clearest evidence the pull is alive.
	log.append("abc123: Downloading 41.2 MB/120 MB\n");
	log.append("abc123: Downloading 62.0 MB/120 MB\n");
	stop();
	// The final tick happened synchronously inside stop's clearInterval, so
	// drive one directly: append then re-run a widget and read the first tick.
	const seen: (string | undefined)[] = [];
	const stop2 = startProgressWidget({ setStatus: (_k, t) => seen.push(t) }, log, "/proj");
	stop2();
	checkTrue("the moving progress line is shown, not just the phase", seen[0]?.includes("Downloading 62.0 MB/120 MB") === true, seen[0]);
	// The buildx form is the one a real feature build produces.
	const seenBytes: (string | undefined)[] = [];
	const logBytes = new BringUpLog();
	logBytes.append("#4 sha256:cd 1.0MB / 43.51MB 2.0s\n");
	const stop3 = startProgressWidget({ setStatus: (_k, t) => seenBytes.push(t) }, logBytes, "/proj");
	stop3();
	checkTrue("a buildx byte counter is shown as the detail", seenBytes[0]?.includes("1.0MB / 43.51MB") === true, seenBytes[0]);

	// The stop has to clear the row, or it lingers after the work is done and
	// claims something is still running.
	checkTrue("stopping clears the status", statuses[statuses.length - 1] === undefined, statuses[statuses.length - 1]);
	checkTrue("stopping clears the working message", working[working.length - 1] === undefined, working[working.length - 1]);

	// A mode with no status bar must not throw: the widget is started on
	// every call, including the ones pi makes outside the TUI.
	let survived = true;
	try {
		startProgressWidget(undefined, log, "/proj")();
		startProgressWidget({}, log, "/proj")();
	} catch {
		survived = false;
	}
	checkTrue("a UI without a status bar is tolerated", survived);
}

// --- a watcher can tell a finished bring-up from a live one ------------
// `pendingUp` is never cleared, so a watcher that polled it would report
// "still building" for the rest of the session.
{
	// The signal the slash command polls: set on BOTH outcomes, because the
	// failure notification is also followed by a catch that resolves.
	const p = Promise.reject(new Error("feature install failed")).catch(() => {});
	let finished = false;
	p.then(() => {
		finished = true;
	});
	await p;
	await new Promise((r) => setTimeout(r, 20));
	checkTrue("a failed bring-up also ends the watch", finished);
}

// --- cancelling a wait actually ends it --------------------------------
// A pull that outlives the call is a session-wide process; the caller's
// patience is not, and esc has to work during the wait.
{
	const log = new BringUpLog();
	const ac = new AbortController();
	const cfg = {
		pendingUp: new Promise<void>(() => {}),
		bringUpLog: log,
		projectCwd: "/proj",
	} as unknown as DevcontainerConfig;
	let msg = "";
	let returned = false;
	const started = Date.now();
	setTimeout(() => ac.abort(), 100);
	try {
		await settleBringUp(cfg, { isEnabled: () => true, signal: ac.signal });
	} catch (err) {
		msg = String((err as Error)?.message ?? err);
	}
	returned = true;
	checkTrue("an abort ends the wait", returned && Date.now() - started < 5000, Date.now() - started);
	// A cancel is not a bring-up failure: the background process is still
	// running, and the message must not claim otherwise.
	checkTrue("an abort is not reported as a failure", !msg.includes("bring-up failed"), msg);
	checkTrue("an abort is not reported as still creating", !msg.includes("still being created"), msg);
}

// --- a progress callback cannot run before its own bindings -----------
// Regression: `onProgress` fires from INSIDE ensureReady, and the emit/schedule
// pair it calls was declared after the wait. The `const schedule` was still in
// its temporal dead zone, so the first pull line of a real bring-up threw
// "Cannot access 'schedule' before initialization" out of the callback and
// turned a working build into a failed tool call. Nothing type-checks this:
// the reference is legal TypeScript, it is just uninitialised at call time.
{
	// Compiled to .smoke-build/, so the source sits one directory up.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	// The run tool's execute body, from its signature to the end of the wait.
	const execute = source.slice(source.indexOf("async execute(_toolCallId, params, signal, onUpdate, ctx)"));
	const wait = execute.indexOf("await ensureReady(");
	checkTrue("the run tool's wait was found", wait > 0, wait);
	const scheduleDecl = execute.indexOf("const schedule =");
	const emitDecl = execute.indexOf("const emit =");
	checkTrue("the emit callback is declared before the wait", emitDecl !== -1 && emitDecl < wait, emitDecl);
	checkTrue("the schedule callback is declared before the wait", scheduleDecl !== -1 && scheduleDecl < wait, scheduleDecl);
	// Ordering alone is not enough: a `let pending` the throttling timer uses
	// must exist before the first onProgress can schedule a tick through it.
	const pendingDecl = execute.indexOf("let pending");
	checkTrue("the throttle timer handle is declared before the wait", pendingDecl !== -1 && pendingDecl < wait, pendingDecl);
	// The same mistake in the rebuild tool would reappear the moment it grew a
	// progress callback, so the rule is checked for both waits.
	const rebuild = source.slice(source.indexOf("name: REBUILD_TOOL_NAME"));
	const rebuildWait = rebuild.indexOf("await ensureReady(");
	checkTrue("the rebuild tool's wait was found", rebuildWait > 0, rebuildWait);
	for (const decl of ["const schedule =", "const emit =", "let pending"]) {
		checkTrue(`the rebuild tool declares ${decl} before its wait`, rebuild.indexOf(decl) !== -1 && rebuild.indexOf(decl) < rebuildWait, decl);
	}
}

// --- bringUp must not hand its caller the bring-up promise -----------
// Regression: `return cfg.pendingUp` at the end of an async function makes
// the CALLER's await wait for the whole bring-up. session_start awaits
// bringUp, so that put the length of a first-run image pull in front of
// pi's startup and the session appeared frozen before the first prompt.
{
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const bringUp = source.slice(source.indexOf("const bringUp = async"), source.indexOf("const rebuildTool"));
	// Matched per line so the comment explaining the fix does not trip it.
	const returnsPending = bringUp.split("\n").some((l) => /^\s*return\s+cfg\.pendingUp/.test(l));
	checkTrue("bringUp does not return the pending promise", !returnsPending, "return cfg.pendingUp");
	// The promise must still be handled, or a failure is an unhandled rejection.
	checkTrue("the pending promise is still caught", bringUp.includes(".catch("), "catch");
	// The doc comment already promises this; the promise is the reason.
	checkTrue(
		"the declaration says bring-up returns immediately",
		/Bring-up itself stays in the BACKGROUND[\s\S]{0,200}awaiting cfg\.pendingUp/.test(source),
		"doc comment",
	);
}

// --- devcontainer_rebuild: a rebuild is bring-up with an argument -----
// The tool exists because a config edit does not always reach the container on
// its own, and the fix has to be a re-run of `up` rather than a second,
// parallel build path that would drift from it.
{
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	// The naming is a convention, not decoration: every tool this extension
	// offers is called devcontainer_<action>, and a model choosing between
	// tools reads the name before it reads the description.
	checkTrue("the rebuild tool is named devcontainer_rebuild", source.includes('REBUILD_TOOL_NAME = "devcontainer_rebuild"'), "name");
	checkTrue("no stale name is left in the source", !source.includes("rebuild_devcontainer"), "stale name");
	checkTrue("the rebuild tool is registered", source.includes("pi.registerTool(rebuildTool)"), "registerTool(rebuildTool)");
	// It has to ride the run tool's activation: a rebuild before the container
	// is up would only report the same wait, worse.
	checkTrue(
		"the rebuild tool is activated with the run tool",
		source.includes("pi.setActiveTools(\n\t\t\t\tnext ? [...names, TOOL_NAME, REBUILD_TOOL_NAME]") ||
			source.includes("[...names, TOOL_NAME, REBUILD_TOOL_NAME]"),
		"setActiveTools",
	);
	checkTrue(
		"a deactivated rebuild tool is removed again",
		source.includes("names.filter((n) => n !== TOOL_NAME && n !== REBUILD_TOOL_NAME)"),
		"filter",
	);
	// extraArgs goes to the CLI verbatim rather than being modelled, so
	// --no-cache works without a flag here.
	const bringUp = source.slice(source.indexOf("const bringUp = async"), source.indexOf("const rebuildTool"));
	// --config precedes extraArgs: the config file location must win over
	// whatever the caller appends.
	checkTrue(
		"extraArgs are appended to the up arguments",
		/upArgs\.push\("--config", cfg\.configPath\);\s*upArgs\.push\(\.\.\.extraArgs\);/.test(bringUp),
		"upArgs",
	);
	checkTrue("bringUp accepts the extra arguments", bringUp.includes("extraArgs: string[] = []"), "signature");
	// The refusal is the part that matters: two `up` processes against one
	// container report each other's failures.
	checkTrue("a rebuild refuses to stack on a running bring-up", source.includes("if (bringUpInFlight) {"), "bringUpInFlight");
	checkTrue(
		"the refusal explains why",
		/a devcontainer bring-up is already running[\s\S]{0,200}Wait for it to finish/.test(source),
		"message",
	);
	// The tool rebuilds before it waits, and refuses with a real reason when
	// there is nothing to rebuild.
	checkTrue("a missing config names the create tool", source.includes('create one with \\`${CREATE_TOOL_NAME}\\`'), "message");
	// Split on whitespace, never shell-parsed: a quote has nothing to escape
	// into, so it cannot smuggle in an extra argv entry.
	checkTrue("extraArgs are split on whitespace, not shell-parsed", source.includes(".trim().split(/\\s+/)"), "split");
}

// --- docker access: share the host daemon by default, never nest -------
// A nested daemon keeps its metadata on whatever filesystem the HOST keeps
// /var/lib/docker on, and on btrfs it stalls on volumes/metadata.db forever:
// the container starts and every `docker` call inside it times out. So a
// scaffolded config shares the host socket — but an EXPLICIT dind feature is
// left exactly as asked, because nesting is how a project keeps the host's
// containers and images out of reach, and rewriting it would undo that.
{
	const dind: Scaffold = scaffold({ projectRoot: "/proj", stack: "none", features: { [DOCKER_IN_DOCKER_FEATURE]: { version: "latest" } } });
	checkTrue("an explicit dind feature is left alone", Object.keys((dind.config.features as Record<string, unknown>) ?? {}).includes(DOCKER_IN_DOCKER_FEATURE) === true);
	checkTrue("an explicit dind gets no host socket mount", dind.config.mounts === undefined);
	checkTrue("an explicit dind is not joined by the socket feature", Object.keys((dind.config.features as Record<string, unknown>) ?? {}).includes(DOCKER_OUTSIDE_OF_DOCKER_FEATURE) === false);

	const shared: Scaffold = scaffold({ projectRoot: "/proj", stack: "none" });
	checkTrue("a default config mounts the host socket", (shared.config.mounts as { target: string }[])?.[0]?.target === "/var/run/docker.sock");
	// The bind mount IS the sharing: the feature would install a CLI and env
	// vars for the same socket, and cannot coexist with a hand-mounted one.
	checkTrue("a default config does not name the socket feature", Object.keys((shared.config.features as Record<string, unknown>) ?? {}).includes(DOCKER_OUTSIDE_OF_DOCKER_FEATURE) === false);

	const optedOut: Scaffold = scaffold({ projectRoot: "/proj", stack: "none", shareHostDocker: false });
	checkTrue("shareHostDocker false adds no socket feature", Object.keys((optedOut.config.features as Record<string, unknown>) ?? {}).includes(DOCKER_OUTSIDE_OF_DOCKER_FEATURE) === false);
	checkTrue("shareHostDocker false mounts no socket", optedOut.config.mounts === undefined);

	// Reading a config's Docker access changes nothing, and says why a nested
	// daemon can be unusable — the fix belongs on the host, not in the config.
	const nested: Record<string, unknown> = {
		image: "mcr.microsoft.com/devcontainers/dotnet:8.0",
		features: { [DOCKER_IN_DOCKER_FEATURE]: { version: "latest" } },
		forwardPorts: [8080],
	};
	const before = JSON.stringify(nested);
	const reported = describeDockerAccess(nested);
	check("a dind config is reported as dind", reported.mode, "dind");
	checkTrue("the dind report names the btrfs failure mode", reported.note.includes("btrfs"), reported.note);
	checkTrue("the dind report says the host is not reachable", reported.note.includes("NOT visible"), reported.note);
	check("inspecting a config does not change it", JSON.stringify(nested), before);
	checkTrue("a dind config is not given a host socket", nested.mounts === undefined);
	checkTrue("a dind config keeps its features", Object.keys((nested.features as Record<string, unknown>)[DOCKER_IN_DOCKER_FEATURE] !== undefined ? (nested.features as Record<string, unknown>) : {}).length === 1);

	// The other two modes are told apart, so the result never claims a shared
	// daemon the config does not actually mount.
	check("a socket config is reported as a host socket", describeDockerAccess({ features: { [DOCKER_OUTSIDE_OF_DOCKER_FEATURE]: {} } }).mode, "host-socket");
	check("a config with no docker feature reports none", describeDockerAccess({ image: "x" }).mode, "none");
	check("a dind feature at another major is still recognized", describeDockerAccess({ features: { "ghcr.io/devcontainers/features/docker-in-docker:2": {} } }).mode, "dind");
}

// --- auto port forwarding: high host ports, announced as FROM->TO -------
// The mechanism rests on three claims, each checkable without a container:
// the kernel's own table can be read, socat is asked for port 0 so the kernel
// picks a free port, and the resulting mapping is announced rather than
// recorded somewhere nobody will look.
{
	// Real /proc/net/tcp output: 0A is TCP_LISTEN, and the port is the second
	// half of a host-order-reversed hex address.
	const proc = [
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12 1 0000 100 0 0 10 0",
		"   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 13 1 0000 100 0 0 10 0",
		"   2: 00000000:C351 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 14 1 0000 100 0 0 10 0",
		"",
	].join("\n");
	const ports = parseListeningPorts(proc);
	check("a listening port is parsed from /proc/net/tcp", ports.includes(3000), true);
	check("a loopback listener is parsed too", ports.includes(8080), true);
	// 0C35 is 50001 in the line above and its state is 01 (ESTABLISHED), not
	// 0A: a relay built from it would forward nothing and look broken.
	check("an established connection is not a listening port", ports.includes(50001), false);
	checkTrue("ports come back sorted", ports.every((p, i) => i === 0 || (ports[i - 1] ?? 0) < p), ports.join(","));

	// A truncated or foreign line must not become a port.
	checkTrue("garbage yields no ports", parseListeningPorts("not a proc line\n\n  \n").length === 0, "garbage");

	// socat binds port 0 so the KERNEL chooses: a check-then-bind race would
	// hand the user a port that was taken between the two.
	const args = socatArgs("172.17.0.3", 3000);
	// -d prints warnings only; which port it bound is only visible at the
	// second level, and that line is the only statement of the mapping.
	checkTrue("socat is verbose enough to report the port it bound", (args[0] ?? "") === "-d" && (args[1] ?? "") === "-d", args.join(" "));
	const listen = args[2] ?? "";
	const target = args[3] ?? "";
	checkTrue("socat is asked for a kernel-chosen port", listen.includes("LISTEN:0,"), listen);
	checkTrue("socat binds loopback only", listen.includes("bind=127.0.0.1"), listen);
	checkTrue("socat forks per connection", listen.includes("fork"), listen);
	check("socat is pointed at the container's address and port", target, "TCP4:172.17.0.3:3000");

	// The reported host port comes from socat's own line, never from a guess.
	// Both wordings are real: -d prints the first, a failure the second.
	check("socat's listening-on line yields the port", parseSocatListenPort("2026/09/30 14:49:34 socat[78874] N listening on AF=2 127.0.0.1:34951"), 34951);
	check("socat's LISTEN line yields the port", parseSocatListenPort("2024/01/01 12:00:00 socat[1] E LISTEN 0.0.0.0:41234"), 41234);
	check("a line without a port yields none", parseSocatListenPort("socat[1] E connect(0, AF=2): Connection refused"), 0);
	// A low number is not a high port, so a line quoting the container's own
	// port must not be reported as the mapping.
	check("a port outside the high range is rejected", parseSocatListenPort("LISTEN 0.0.0.0:3000"), 0);

	// The mapping has to reach both audiences: the user (a notice) and the
	// model (the tool result). Either alone leaves the other guessing.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const portsSource = readFileSync(new URL("../ports.ts", import.meta.url), "utf8");
	checkTrue("the mapping is announced to the user", portsSource.includes("container port ${containerPort} -> host 127.0.0.1:${hostPort}"), "notice");
	checkTrue("the mapping is in the tool result", source.includes("${p.containerPort} -> 127.0.0.1:${p.hostPort}"), "header");
	checkTrue("the model is told localhost:<container port> is not the service", source.includes("NOT the container"), "guideline");
	checkTrue("a ports command lists the mapping", source.includes('registerCommand("devcontainer-ports"'), "command");
	// Declared forwardPorts are published by `up` itself; relaying them again
	// would give one service two URLs.
	checkTrue("already-published ports are not relayed again", portsSource.includes("this.declared.has(port)"), "skip");
	// The CLI names its own container, so the extension must look it up by
	// label rather than inspect the name it invented for its own container.
	checkTrue("the CLI container is found by its label", portsSource.includes("devcontainer.local_folder"), "label");
	// A relay must not outlive the session that bound host ports for it.
	checkTrue("the forwarder is stopped at shutdown", source.includes("forwarder?.stop()"), "stop");
	// The container's own infrastructure is not published.
	checkTrue("debug and daemon ports are skipped", portsSource.includes("SKIP_PORTS"), "SKIP_PORTS");
}

console.log(failures === 0 ? `\nALL ${checks} CHECKS PASSED` : `\n${failures}/${checks} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
