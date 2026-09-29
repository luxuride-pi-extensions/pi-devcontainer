/**
 * Look up devcontainer features from the published catalog at
 * https://containers.dev/features.
 *
 * That page is the authoritative machine-readable-ish source: a static table
 * of ~1440 features, each row carrying the feature name, its maintainer, the
 * exact OCI reference INCLUDING the major tag (e.g.
 * `ghcr.io/devcontainers/features/node:1`), and the feature's own version
 * (`2.1.0`). The site builds it by reading every collection repo's `src/`, so
 * it already contains every community collection — no per-repo API calls, and
 * no guessing about which collections exist.
 *
 * The older `_data/collection-index.yml` is deliberately NOT used: it lists
 * 317 collections and never names a feature inside them, so it cannot answer
 * "is there a postgres feature anywhere" without a fan-out over every repo.
 *
 * The page is ~570KB of HTML, fetched once a day and cached; the parsed form
 * is kept separately so a session can read it without re-parsing. A stale cache
 * is served when the network is unavailable — a catalog a day out of date beats
 * no catalog, since a bad reference only fails at build time.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CATALOG_URL = "https://containers.dev/features";
const CACHE_DIR = join(homedir(), ".cache", "pi-devcontainer");
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface CatalogFeature {
	/** Display name, e.g. "Node.js". */
	name: string;
	/** Maintainer, as shown on the site. */
	maintainer: string;
	/** Full OCI reference with the major tag, ready to paste into a config. */
	ref: string;
	/** The feature's own version, which is NOT the tag in `ref`. */
	version: string;
}

/** An OCI reference split into the parts a config needs. */
export interface ParsedRef {
	host: string;
	collection: string;
	feature: string;
	/** Major version tag; the catalog always supplies one. */
	tag: string;
}

/**
 * Split `ghcr.io/owner/name/feature:1` into its parts.
 *
 * A collection is a host plus one to three more segments, and the feature is
 * the LAST segment, so the collection is matched as "as many segments as
 * still leave a feature behind" — that handles both `ghcr.io/a/b` (feature c)
 * and `ghcr.io/rails/devcontainer/features` (feature postgres-client). The
 * tag is always digits: these are major-version image tags.
 */
export function parseRef(ref: string): ParsedRef | undefined {
	const m = ref.match(/^([a-z0-9.-]+\.[a-z]{2,})\/((?:[^\s/]+\/){1,3})([^\s/:]+):(\d+)$/i);
	if (!m) return undefined;
	return { host: m[1]!, collection: `${m[1]}/${m[2]!.slice(0, -1)}`, feature: m[3]!, tag: m[4]! };
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { "user-agent": "pi-devcontainer-extension" },
	});
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
	return res.text();
}

function readCache<T>(key: string): { data: T; fetchedAt: number } | undefined {
	try {
		return JSON.parse(readFileSync(join(CACHE_DIR, `${key}.json`), "utf-8")) as { data: T; fetchedAt: number };
	} catch {
		return undefined;
	}
}

function writeCache(key: string, data: unknown): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ fetchedAt: Date.now(), data }));
	} catch {
		// A read-only HOME must not break the lookup.
	}
}

function decode(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Parse the features table.
 *
 * Each row is: feature name (a link), maintainer, `<code>` OCI reference,
 * `<code>` version. Only rows with two code cells AND a reference that parses
 * are kept — the page has a couple of malformed entries, and a bogus
 * reference in the catalog would be handed straight to the model as if it
 * were verified.
 */
export function parseFeaturesPage(html: string): CatalogFeature[] {
	const out: CatalogFeature[] = [];
	const seen = new Set<string>();
	const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, " "));
	for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const body = row[1] ?? "";
		const name = body.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
		if (!name) continue;
		const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? "");
		const codes = [...body.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1] ?? ""));
		if (cells.length === 0 || codes.length < 2) continue;
		const ref = codes[0]!;
		if (!parseRef(ref)) continue;
		if (seen.has(ref)) continue;
		seen.add(ref);
		// The maintainer sits in its own cell, so it is the first cell that
		// carries neither the name link nor a code block. Guessing by index
		// would silently pick the wrong cell if the site's column order ever
		// changed.
		const maintainerCell = cells.find((c) => !c.includes("<a") && !c.includes("<code")) ?? "";
		out.push({ name: decode(name), maintainer: stripTags(maintainerCell), ref, version: codes[1]! });
	}
	return out;
}

let inflight: Promise<CatalogFeature[]> | null = null;

/**
 * The whole catalog, from a day-old cache when possible.
 *
 * `inflight` dedupes concurrent calls: two tool calls in the same turn would
 * otherwise both miss the cache and both fetch 570KB.
 */
export async function loadCatalog(): Promise<{ features: CatalogFeature[]; fromCache: boolean }> {
	const cached = readCache<CatalogFeature[]>("features-catalog");
	if (cached && Date.now() - cached.fetchedAt <= TTL_MS) {
		return { features: cached.data, fromCache: true };
	}
	if (!inflight) {
		inflight = (async () => {
			const features = parseFeaturesPage(await fetchText(CATALOG_URL));
			if (features.length === 0) throw new Error("parsed no features from the catalog page");
			writeCache("features-catalog", features);
			return features;
		})().finally(() => {
			inflight = null;
		});
	}
	try {
		return { features: await inflight, fromCache: false };
	} catch (err) {
		if (cached) return { features: cached.data, fromCache: true };
		throw new Error(
			`could not fetch the devcontainer feature catalog (${err instanceof Error ? err.message : String(err)}) and no cached copy is available`,
		);
	}
}

/**
 * Search features by name, reference or maintainer.
 *
 * Every term must match somewhere, so "node javascript" narrows rather than
 * widens. An exact reference match always wins, because that is what the model
 * asks for when it already knows the answer.
 */
export async function searchFeatures(query: string, limit = 25): Promise<{ text: string }> {
	const { features, fromCache } = await loadCatalog();
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

	let matched: CatalogFeature[];
	if (terms.length === 0) {
		matched = features;
	} else {
		const exact = features.filter((f) => f.ref.toLowerCase().includes(query.trim().toLowerCase()) && f.ref.toLowerCase().includes("/"));
		matched = exact.length > 0
			? exact
			: features.filter((f) => {
					const hay = `${f.name} ${f.maintainer} ${f.ref}`.toLowerCase();
					return terms.every((t) => hay.includes(t));
				});
	}

	const lines = matched.length === 0
		? `no feature matching "${query}" in the catalog (${features.length} features)`
		: `${matched.length} of ${features.length} features match${fromCache ? " [cached]" : ""}:`;
	const body = matched.slice(0, limit).map((f) => {
		const bits = [`  ${f.ref}`];
		if (f.name) bits.push(`  ${f.name}`);
		if (f.maintainer) bits.push(`  (${f.maintainer}, version ${f.version})`);
		return bits.join("\n");
	});
	const tail = matched.length > limit
		? ["", `showing ${limit} of ${matched.length}; narrow the query to see the rest`]
		: [];
	return { text: [lines, ...body, ...tail].join("\n") };
}

/** Every feature in one collection, from the catalog. */
export async function featuresInCollection(collection: string): Promise<{ text: string }> {
	const wanted = collection.trim().replace(/^ghcr\.io\//, "").replace(/[:/]+$/, "").toLowerCase();
	const { features } = await loadCatalog();
	const names = features
		.filter((f) => {
			const parsed = parseRef(f.ref);
			return parsed && parsed.collection.toLowerCase().replace(/^ghcr\.io\//, "") === wanted;
		})
		.map((f) => f.ref);
	if (names.length === 0) {
		throw new Error(`no feature in the catalog belongs to ${collection}`);
	}
	return {
		text: [
			`${names.length} feature${names.length === 1 ? "" : "s"} in ${collection}:`,
			...names.map((n) => `  ${n}`),
		].join("\n"),
	};
}

/** Distinct collections in the catalog, with their feature counts. */
export function collectionsIn(features: CatalogFeature[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const f of features) {
		const parsed = parseRef(f.ref);
		if (!parsed) continue;
		counts.set(parsed.collection, (counts.get(parsed.collection) ?? 0) + 1);
	}
	return counts;
}
