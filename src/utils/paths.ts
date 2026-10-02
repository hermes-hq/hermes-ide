// ─── Path labels that work on every OS ───────────────────────────────────
//
// A path can come from macOS/Linux ("/home-fixture/demo-app") or Windows
// ("D:\work\demo-app", sometimes mixed with "/"). Labels built with
// split("/") showed the whole Windows path; these helpers split on both.

/** The last part of a path ("demo-app"), whatever its separators; trailing separators ignored. */
export function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return path;
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}

/**
 * A path under `home` as "~/…" with "/" separators ("~/proj", never
 * "~//proj"); `home` itself is "~". A path that only starts with the same
 * letters ("/srv/test2" under "/srv/test") is not under it and is
 * returned as it is. Windows paths compare without regard to case.
 */
export function tildePath(path: string, home: string | null | undefined): string {
	if (!home) return path;
	const h = home.replace(/[\\/]+$/, "");
	if (!h) return path;
	const windows = /^[A-Za-z]:[\\/]/.test(h) || h.includes("\\");
	const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
	if (same(path.replace(/[\\/]+$/, ""), h)) return "~";
	const head = path.slice(0, h.length);
	const sep = path.charAt(h.length);
	if (!same(head, h) || (sep !== "/" && sep !== "\\")) return path;
	const rest = path
		.slice(h.length)
		.replace(/^[\\/]+/, "")
		.replace(/\\/g, "/");
	return rest ? `~/${rest}` : "~";
}
