import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { run } from "./exec.js";

/**
 * Publish ports the container opens on to the host, as they open.
 *
 * `devcontainer up` forwards the ports the config DECLARES, which is the
 * right mechanism for a known service and useless for one you have not
 * started yet: the dev server a developer runs on 3000 long after the
 * container came up stays invisible to the host. This closes that gap by
 * noticing listening sockets inside the container and relaying each one.
 *
 * Host ports are taken from the ephemeral range rather than reusing the
 * container's number. A container port 3000 is a statement about the
 * project; on the host, 3000 is often already the developer's own other
 * server, and silently taking it would move that service to a failure or,
 * worse, leave the developer testing against the wrong process. The mapping
 * is reported instead, so the cost is one lookup and the benefit is that
 * nothing already listening can be disturbed.
 *
 * socat does the relay rather than a Node listener per port: it forks
 * per connection, so a request that opens several sockets (HTTP keep-alive,
 * a browser preloading assets) is not serialized behind the last one, and
 * it survives a session ending without leaving a node process behind.
 */

/** Start of the IANA dynamic/private range, the pool high ports come from. */
const HOST_PORT_MIN = 32768;
const HOST_PORT_MAX = 60999;

/** How often the container is asked what it is listening on. */
const POLL_MS = 3000;

/**
 * Container ports never relayed: the container's own infrastructure, which
 * is either useless on the host or actively harmful to expose.
 */
const SKIP_PORTS = new Set([
	// The devcontainer CLI's own exec server, bound inside the container.
	22, 23, 2375, 2376, 6443,
	// Language runtimes' debug ports talk to a client that is expected to be
	// inside the container, and publishing them forwards an unauthenticated
	// debugger to the loopback interface.
	9229, // node --inspect
	9230, // node --inspect secondary port
	5858, // dart/flutter debug
]);

export interface ForwardedPort {
	/** The port inside the container. */
	containerPort: number;
	/** The high port it is published on, on 127.0.0.1 only. */
	hostPort: number;
}

export interface ForwarderEvents {
	/** A newly published port. */
	onPublished?: (port: ForwardedPort) => void;
	/** Something worth telling the user about, phrased as a sentence. */
	onNotice?: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * Listening TCP ports inside a container, from /proc/net/tcp{,6}.
 *
 * /proc rather than `ss` or `netstat`: neither is present in a slim image
 * (and installing one into someone's devcontainer to watch ports would be
 * absurd), while the kernel's own table is always there. State 0A is
 * TCP_LISTEN; the port is the second half of the hex local_address, so the
 * host byte order has to be swapped back.
 */
export function parseListeningPorts(output: string): number[] {
	const ports = new Set<number>();
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 4) continue;
		if (fields[3] !== "0A") continue; // TCP_LISTEN
		const local = fields[1] ?? "";
		const colon = local.lastIndexOf(":");
		if (colon < 0) continue;
		const port = parseInt(local.slice(colon + 1), 16);
		// A port is 16 bits; anything else is a truncated or foreign line
		// rather than a port, and relaying it would fail confusingly.
		if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
		ports.add(port);
	}
	return [...ports].sort((a, b) => a - b);
}

/** socat's command line for one relay. Split out so it can be asserted on. */
export function socatArgs(containerIp: string, containerPort: number, hostPort = 0): string[] {
	return [
		// -d prints warnings only; the port it bound is only visible at the second
	// level, and it is the only statement of WHICH port it chose.
		"-d",
		"-d",
		// Port 0 lets the KERNEL choose a free one, so nothing has to guess
		// whether a port is free between the check and the bind.
		`TCP4-LISTEN:${hostPort},bind=127.0.0.1,reuseaddr,fork`,
		`TCP4:${containerIp}:${containerPort}`,
	];
}

/**
 * The host port socat actually bound, which it prints once it is listening.
 * Returns 0 when the line does not say, so the caller can report a relay as
 * unpublished rather than inventing a number.
 */
export function parseSocatListenPort(line: string): number {
	// socat -d prints "N listening on AF=2 127.0.0.1:34951" or
	// "E LISTEN 0.0.0.0:41234". The port is whatever follows the LAST colon,
	// because "AF=2" carries digits of its own and a greedy \D+ run stops
	// matching there.
	const match = /(?:LISTEN|listening on)[^\n]*?:(\d{2,5})\b/.exec(line);
	if (!match?.[1]) return 0;
	const port = Number.parseInt(match[1], 10);
	return port >= HOST_PORT_MIN && port <= HOST_PORT_MAX ? port : 0;
}

/**
 * Find the container the CLI created. `devcontainer up` names it after the
 * project and keeps it running, so the name this extension invents for its
 * own docker-fallback container is never the right one to inspect.
 */
export async function findCliContainer(configRoot: string): Promise<string | null> {
	const r = await run("docker", [
		"ps",
		"--filter",
		`label=devcontainer.local_folder=${configRoot}`,
		"--format",
		"{{.Names}}",
	]);
	if (r.code !== 0) return null;
	const name = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
	return name ?? null;
}

export class PortForwarder {
	private timer: NodeJS.Timeout | undefined;
	/** containerPort -> the relay process publishing it. */
	private relays = new Map<number, ChildProcess>();
	/** Published mappings, for the tool result to report. */
	private published: ForwardedPort[] = [];
	/** Container ports already published by `devcontainer up` itself. */
	private declared = new Set<number>();

	constructor(
		private readonly containerName: string,
		private readonly events: ForwarderEvents = {},
	) {}

	list(): ForwardedPort[] {
		return this.published.map((p) => ({ ...p }));
	}

	/**
	 * Ports `devcontainer up` already publishes on the host. A duplicate relay
	 * would give two URLs for one service and make the ambiguity the user's
	 * problem to resolve, so they are recorded once and skipped.
	 */
	async noteDeclaredPorts(): Promise<void> {
		for (const port of await this.declaredContainerPorts()) this.declared.add(port);
	}

	private async declaredContainerPorts(): Promise<number[]> {
		const r = await run("docker", [
			"inspect",
			"-f",
			"{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} {{end}}",
			this.containerName,
		]);
		if (r.code !== 0) return [];
		return r.stdout
			.split(/\s+/)
			.filter(Boolean)
			.map((p) => Number.parseInt(p, 10))
			.filter((p) => Number.isInteger(p) && p > 0);
	}

	private async containerIp(): Promise<string | null> {
		const r = await run("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", this.containerName]);
		const ip = r.stdout.trim();
		return r.code === 0 && ip ? ip : null;
	}

	start(): void {
		if (this.timer) return;
		// unref: the forwarder is a convenience for the session, and a poll
		// loop must never be the reason node stays alive.
		this.timer = setInterval(() => void this.poll(), POLL_MS);
		this.timer.unref?.();
		void this.poll();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		for (const child of this.relays.values()) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		this.relays.clear();
		this.published = [];
	}

	private async poll(): Promise<void> {
		if (this.relays.size > 32) return; // a runaway listener loop is not a dev server
		// Both families in one exec: two docker round trips per poll would be
		// wasted on a loop this frequent.
		const listening = await run("docker", ["exec", this.containerName, "cat", "/proc/net/tcp", "/proc/net/tcp6"]);
		if (listening.code !== 0) return; // container restarting or gone
		const ip = await this.containerIp();
		if (!ip) return;
		for (const port of parseListeningPorts(listening.stdout)) {
			if (this.relays.has(port) || this.declared.has(port) || SKIP_PORTS.has(port)) continue;
			this.relay(ip, port);
		}
	}

	private relay(containerIp: string, containerPort: number): void {
		const child = spawn("socat", socatArgs(containerIp, containerPort), { stdio: ["ignore", "ignore", "pipe"] });
		child.unref();
		// socat reports the port it bound on stderr; without that line there
		// is no honest port to report, so the relay is torn down rather than
		// published as something the user cannot connect to.
		const settle = (line: string): void => {
			const hostPort = parseSocatListenPort(line);
			if (hostPort === 0) return;
			this.relays.set(containerPort, child);
			this.published.push({ containerPort, hostPort });
			this.events.onPublished?.({ containerPort, hostPort });
			this.events.onNotice?.(
				`devcontainer: container port ${containerPort} -> host 127.0.0.1:${hostPort} (a free high port, so nothing already on the host was displaced)`,
			);
		};
		let announced = false;
		child.stderr?.on("data", (d: Buffer) => {
			if (announced) return;
			for (const line of d.toString().split(/\r?\n/)) {
				if (parseSocatListenPort(line) === 0) continue;
				announced = true;
				settle(line);
				return;
			}
		});
		child.on("error", (err) => {
			// Almost always socat missing. Reported once rather than every poll.
			this.events.onNotice?.(`devcontainer: cannot forward ports (${String(err.message)}) — install socat on the host, or use the ports devcontainer up already published`);
			this.relays.delete(containerPort);
		});
		child.on("exit", (code) => {
			// A relay that died has to be republished or the port silently stops
			// being reachable while the container still listens.
			if (code !== 0 && !announced) {
				this.events.onNotice?.(`devcontainer: port ${containerPort} could not be forwarded (socat exited ${code})`);
			}
			this.relays.delete(containerPort);
			this.published = this.published.filter((p) => p.containerPort !== containerPort);
		});
	}
}

/**
 * A free host port, for a caller that must bind one itself. socat is asked
 * for port 0 instead wherever it can do the binding, so this exists only for
 * the case where the relay is a Node listener.
 */
export function findFreeHostPort(): Promise<number> {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.on("error", () => {
			// No socket to close; report the bottom of the range and let the
			// caller's own bind surface a real error.
			resolvePort(HOST_PORT_MIN);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : HOST_PORT_MIN;
			server.close(() => resolvePort(port));
		});
	});
}

export const HOST_PORT_RANGE = { min: HOST_PORT_MIN, max: HOST_PORT_MAX };