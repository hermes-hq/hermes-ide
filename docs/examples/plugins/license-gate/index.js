// License Gate — sample plugin for Hermes plugin API v2.
//
// Plain JavaScript, no build step: this file is the bundle Hermes loads
// (the manifest's "main"). It shows the four v2 namespaces:
//
//   review.registerCheck  a "License scan" the Review Desk runs over a diff;
//                         it fails when an added line carries a copyleft
//                         license (GPL, AGPL, LGPL, SSPL, EUPL)
//   inbox.raise           on a failed scan, a gate item for the session, so
//                         a person decides before the change lands; a later
//                         clean scan of the same session resolves it
//   features.list         read-only: names the feature track the session is
//                         working on in the gate's text
//   agents.onEvent        the same events for every agent: counts the turns
//                         that ended since the session was last scanned
//
// See docs/plugin-api-v2.md.
(() => {
	const ID = "example.license-gate";

	// SPDX identifiers of copyleft licenses, as whole words, with the usual
	// suffixes (-only, -or-later, +), and the license texts' own titles.
	const SPDX = /\b((?:A|L)?GPL-[23]\.[01](?:-only|-or-later|\+)?|SSPL-1\.0|EUPL-1\.[12])\b/;
	const TITLE = /GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i;

	function licenseIn(text) {
		const spdx = SPDX.exec(text);
		if (spdx) return spdx[1];
		const title = TITLE.exec(text);
		if (title) return title[1] ? `${/affero/i.test(title[1]) ? "AGPL" : "LGPL"} license text` : "GPL license text";
		return null;
	}

	function scan(input) {
		const findings = [];
		for (const file of input.files) {
			if (file.binary || file.status === "deleted") continue;
			for (const added of file.added) {
				const license = licenseIn(added.text);
				if (license) findings.push({ file: file.path, line: added.line, license });
			}
		}
		return findings;
	}

	const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

	window.__hermesPlugins = window.__hermesPlugins || {};
	window.__hermesPlugins[ID] = {
		activate(api) {
			if (api.apiVersion !== 2) throw new Error("License Gate needs plugin API v2");

			// Turns that ended since each session's last scan.
			const unscanned = new Map();
			api.agents.onEvent(({ sessionId, event }) => {
				if (event.type === "turn_end") unscanned.set(sessionId, (unscanned.get(sessionId) || 0) + 1);
				if (event.type === "exit") unscanned.delete(sessionId);
			});

			api.review.registerCheck({
				id: "license-scan",
				title: "License scan",
				description: "Flags copyleft licenses (GPL, AGPL, LGPL, SSPL, EUPL) in added lines",
				async run(input) {
					const turns = unscanned.get(input.sessionId) || 0;
					unscanned.delete(input.sessionId);
					const since = turns > 0 ? ` (${plural(turns, "turn")} since the last scan)` : "";
					const findings = scan(input);
					const open = api.inbox.list().filter((item) => item.sessionId === input.sessionId);

					if (findings.length === 0) {
						// Clean again: the gate this plugin raised earlier is settled.
						for (const item of open) api.inbox.resolve(item.id);
						return {
							outcome: "pass",
							summary: `No copyleft license in ${plural(input.files.length, "changed file")}${since}`,
							findings: [],
						};
					}

					let feature = null;
					try {
						const tracks = await api.features.list(input.sessionId);
						feature = tracks.find((t) => t.ok && t.meta.phase !== "done") || null;
					} catch {
						// No feature tracks readable: the gate just says less.
					}
					const first = findings[0];
					const where = feature ? ` (feature ${feature.slug}, ${feature.meta.phase})` : "";
					api.inbox.raise({
						kind: "gate",
						sessionId: input.sessionId,
						detail: `License review: ${first.license} in ${first.file}${where}`,
					});
					return {
						outcome: "fail",
						summary: `${plural(findings.length, "copyleft license")} found${since}`,
						findings: findings.map((f) => ({
							file: f.file,
							line: f.line,
							message: `${f.license}: needs a license review before this lands`,
						})),
					};
				},
			});
		},
	};
})();
