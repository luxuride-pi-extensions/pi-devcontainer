/**
 * Look up devcontainer feature COLLECTIONS from the published index.
 *
 * `collection-index.yml` is NOT a feature list: it is 317 entries of
 * `{name, maintainer, contact, repository, ociReference}` — the collections
 * themselves (ghcr.io/devcontainers/features, ghcr.io/rocker-org/…, and
 * several hundred community ones). The individual feature names live one
 * level down, as `src/<name>/` directories in each collection's repository.
 * So a lookup is at most two hops: index first, then the chosen repo.
 *
 * Everything is cached under ~/.cache/pi-devcontainer for a day and a stale
 * cache is served when the network is unavailable, because a tool that fails
 * whenever GitHub is slow is worse than one that is occasionally a day stale.
 * Feature catalogs move on the order of months, so a day costs nothing.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const INDEX_URL =
	"https://raw.githubusercontent.com/devcontainers/devcontainers.github.io/refs/heads/gh-pages/_data/collection-index.yml";
const CACHE_DIR = join(homedir(), ".cache", "pi-devcontainer");
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface Collection {
	/** Display name, e.g. "Features for R". */
	name: string;
	maintainer: string;
	/** Issue tracker or contact URL. */
	contact: string;
	repository: string;
	/** Base OCI reference features are written against, e.g. ghcr.io/devcontainers/features. */
	ociReference: string;
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: {
			// The GitHub API rejects requests without a User-Agent.
			"user-agent": "pi-devcontainer-extension",
			accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
	return res.text();
}

interface CacheEntry<T> {
	fetchedAt: number;
	data: T;
}

function readCache<T>(key: string, maxAgeMs: number): T | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(CACHE_DIR, `${key}.json`), "utf-8")) as CacheEntry<T>;
		if (Date.now() - raw.fetchedAt <= maxAgeMs) return raw.data;
		// Stale but present: returned only as a fallback, so the age is
		// reported to the caller instead of silently presented as current.
		return raw.data;
	} catch {
		return undefined;
	}
}

function isFresh(key: string, maxAgeMs: number): boolean {
	try {
		const raw = JSON.parse(readFileSync(join(CACHE_DIR, `${key}.json`), "utf-8")) as CacheEntry<unknown>;
		return Date.now() - raw.fetchedAt <= maxAgeMs;
	} catch {
		return false;
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

/** Load the collection index, preferring a fresh cache over the network. */
async function loadCollections(): Promise<{ collections: Collection[]; fromCache: boolean }> {
	const cacheKey = "collection-index";
	if (isFresh(cacheKey, TTL_MS)) {
		return { collections: readCache<Collection[]>(cacheKey, Infinity) ?? [], fromCache: true };
	}
	try {
		const text = await fetchText(INDEX_URL);
		const collections = parseCollectionIndex(text);
		writeCache(cacheKey, collections);
		return { collections, fromCache: false };
	} catch (err) {
		const stale = readCache<Collection[]>(cacheKey, Infinity);
		if (stale) return { collections: stale, fromCache: true };
		throw new Error(
			`could not fetch the devcontainer collection index (${err instanceof Error ? err.message : String(err)}) and no cached copy is available`,
		);
	}
}

/**
 * Parse the index's flat YAML list.
 *
 * Hand-rolled rather than pulling in a YAML parser: the file is 317 blocks of
 * five scalar keys and nothing else, so the only subtleties are (a) values
 * containing colons, which URLs and OCI references both do — hence splitting
 * on the first ": " — and (b) quoted values. A real parser would be more
 * correct on paper and a dependency for one shape of one file.
 */
export function parseCollectionIndex(text: string): Collection[] {
	const collections: Collection[] = [];
	let current: Partial<Collection> | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const isEntry = line.startsWith("- ");
		const body = isEntry ? line.slice(2) : line.trim();
		if (isEntry) {
			if (current) collections.push(current as Collection);
			current = {};
		}
		if (!current) continue;
		const sep = body.indexOf(": ");
		if (sep === -1) continue;
		const key = body.slice(0, sep);
		const value = unquote(body.slice(sep + 2));
		if (key === "name") current.name = value;
		else if (key === "maintainer") current.maintainer = value;
		else if (key === "contact") current.contact = value;
		else if (key === "repository") current.repository = value;
		else if (key === "ociReference") current.ociReference = value;
	}
	if (current) collections.push(current as Collection);
	return collections.filter((c) => c.name && c.ociReference);
}

function unquote(value: string): string {
	const m = value.match(/^"(.*)"$/s) ?? value.match(/^'(.*)'$/s);
	return (m?.[1] ?? value).trim();
}

/** Search collections by name, maintainer or OCI reference. */
export async function searchCollections(query: string): Promise<{ text: string }> {
	const { collections, fromCache } = await loadCollections();
	const q = query.trim().toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	// Every term must match somewhere: "postgres rocker" should not return
	// every collection maintained by someone whose name contains "rocker".
	const matches = collections.filter((c) => {
		const hay = `${c.name} ${c.maintainer} ${c.ociReference} ${c.repository}`.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
	const shown = matches.slice(0, 40);
	const lines = shown.map((c) => `${c.ociReference}  — ${c.name} (${c.maintainer})`);
	const header = [
		`${matches.length} matching collection${matches.length === 1 ? "" : "s"}${matches.length > shown.length ? ` (showing ${shown.length})` : ""}${fromCache ? " [cached]" : ""}:`,
		...lines,
	];
	if (matches.length === 0) {
		header.push("", "No collection matched. Call with `collection` set to a full OCI reference to list one that is not in the index.");
	}
	return { text: header.join("\n") };
}

/** ghcr.io/owner/name -> owner/name, for building a raw.githubusercontent URL. */
export function repoSlug(ociReference: string): string {
	return ociReference.replace(/^ghcr\.io\//, "").replace(/[:/]+$/, "");
}

/**
 * List a collection's features from its `src/` directory.
 *
 * Accepts a full OCI reference, a bare `owner/name`, or a GitHub URL: the
 * model may hold any of the three, and rejecting two of them would just cause
 * a wasted round trip.
 */
export async function listFeatures(reference: string): Promise<{ text: string }> {
	const ref = reference.trim();
	const slug = /^(https?:\/\/)?github\.com\//.test(ref)
		? ref.replace(/^.*github\.com\//, "").replace(/\.git$/, "").replace(/\/tree\/.*$/, "")
		: repoSlug(ref);
	if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
		throw new Error(`"${ref}" is not a feature collection reference; expected something like ghcr.io/devcontainers/features`);
	}
	const cacheKey = `features-${slug.replace(/[^a-z0-9.-]/gi, "_")}`;
	if (isFresh(cacheKey, TTL_MS)) {
		return { text: formatFeatures(readCache<string[]>(cacheKey, Infinity) ?? [], slug, true) };
	}
	let names: string[];
	try {
		const text = await fetchText(`https://api.github.com/repos/${slug}/contents/src`);
		const entries = JSON.parse(text) as { type: string; name: string }[];
		// Feature directories only: a collection may also carry non-feature
		// files in src/ (tests, templates) that would produce bogus ids.
		names = entries.filter((e) => e.type === "dir").map((e) => e.name).sort();
		if (names.length === 0) throw new Error("no feature directories in src/");
		writeCache(cacheKey, names);
	} catch (err) {
		const stale = readCache<string[]>(cacheKey, Infinity);
		if (!stale) {
			throw new Error(
				`could not list features for ${slug} (${err instanceof Error ? err.message : String(err)}) and no cached copy is available`,
			);
		}
		names = stale;
	}
	return { text: formatFeatures(names, slug, false) };
}

function formatFeatures(names: string[], slug: string, fromCache: boolean): string {
	const header = [
		`${names.length} feature${names.length === 1 ? "" : "s"} in ${slug}${fromCache ? " [cached]" : ""}:`,
		names.map((n) => `  ${slug}:${n}`).join("\n"),
		"",
		"Reference one as a `features` entry in a devcontainer.json, e.g. `\"ghcr.io/devcontainers/features/rust:1\": {}`.",
		"The `:1` suffix is a MAJOR version tag on the published image, not the feature's own version; call this tool with `feature:` for the declared version and options.",
	];
	return header.join("\n");
}
