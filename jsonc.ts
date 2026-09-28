

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export /** Narrow an untyped JSON value to a plain (non-array) object. */
function asJsonObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseJsonc(text: string): JsonValue {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		let out = "";
		let inString = false;
		let escaped = false;
		let inLine = false;
		let inBlock = false;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			const next = text[i + 1];
			if (inLine) {
				if (c === "\n") {
					inLine = false;
					out += c;
				}
				continue;
			}
			if (inBlock) {
				if (c === "*" && next === "/") {
					inBlock = false;
					i++;
				}
				continue;
			}
			if (inString) {
				out += c;
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === '"') inString = false;
				continue;
			}
			if (c === '"') {
				inString = true;
				out += c;
				continue;
			}
			if (c === "/" && next === "/") {
				inLine = true;
				i++;
				continue;
			}
			if (c === "/" && next === "*") {
				inBlock = true;
				i++;
				continue;
			}
			out += c;
		}
		// Remove trailing commas before } or ] with a second STRING-AWARE pass.
		// `out` is still raw text and therefore still contains string
		// literals, so a bare regex would corrupt values such as
		// "sed -e 's/,}//' file.json" (verified: it lost the comma AND the
		// brace, silently changing the command). Instead, remember the
		// position of the last comma and drop it only when the next
		// non-whitespace character turns out to be } or ].
		let res = "";
		let pendingComma = -1; // index into `res`, or -1 when there is none
		inString = false;
		escaped = false;
		for (const c of out) {
			if (inString) {
				res += c;
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === '"') inString = false;
				continue;
			}
			if (c === " " || c === "\t" || c === "\r" || c === "\n") {
				res += c;
				continue;
			}
			if (c === ",") {
				res += c;
				pendingComma = res.length - 1;
				continue;
			}
			res += c;
			if (pendingComma >= 0 && (c === "}" || c === "]")) {
				res = res.slice(0, pendingComma) + res.slice(pendingComma + 1);
			}
			pendingComma = -1;
			if (c === '"') inString = true;
		}
		return JSON.parse(res) as JsonValue;
	}
}
