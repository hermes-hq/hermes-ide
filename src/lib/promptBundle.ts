// ─── Prompt Bundle ────────────────────────────────────────────────────
//
// Self-contained export/import format for prompt templates and their
// custom role/style dependencies. Uses `.hermes-prompts` file extension
// (JSON internally) to distinguish from the full settings export.

import type { PromptTemplate } from "./templates";
import type { RoleDefinition } from "./roles";
import type { StyleDefinition } from "./styles";

// ── Types ────────────────────────────────────────────────────────────

export interface PromptBundle {
	_hermes_bundle_version: number;
	_hermes_app_version: string;
	_hermes_exported_at: string;
	_hermes_bundle_name?: string;
	templates: PromptTemplate[];
	roles: RoleDefinition[];
	styles: StyleDefinition[];
}

export interface BundleImportResult {
	templatesAdded: number;
	templatesSkipped: number;
	/** Subset of `templatesSkipped` whose roles/styles differ from the
	 *  existing template they matched by content — see `rolesOrStylesDiffer`. */
	templatesSkippedRoleStyleDiff: number;
	templatesRenamed: number;
	rolesAdded: number;
	stylesAdded: number;
}

// ── Constants ────────────────────────────────────────────────────────

const BUNDLE_VERSION = 1;

// ── Export ────────────────────────────────────────────────────────────

/**
 * Create a self-contained bundle from the given templates, resolving
 * their custom role/style dependencies. Built-in roles and styles are
 * excluded — they'll be resolved from the target app on import.
 */
export function createBundle(
	templates: PromptTemplate[],
	customRoles: RoleDefinition[],
	customStyles: StyleDefinition[],
	builtInRoleIds: Set<string>,
	builtInStyleIds: Set<string>,
	appVersion: string,
	bundleName?: string,
): PromptBundle {
	// Collect all referenced role/style IDs from the templates
	const referencedRoleIds = new Set<string>();
	const referencedStyleIds = new Set<string>();

	for (const tpl of templates) {
		for (const rid of tpl.fields?.roleIds ?? []) {
			if (!builtInRoleIds.has(rid)) referencedRoleIds.add(rid);
		}
		for (const rid of tpl.recommendedRoles ?? []) {
			if (!builtInRoleIds.has(rid)) referencedRoleIds.add(rid);
		}
		for (const sel of tpl.fields?.styleSelections ?? []) {
			if (!builtInStyleIds.has(sel.id)) referencedStyleIds.add(sel.id);
		}
		for (const sel of tpl.recommendedStyles ?? []) {
			if (!builtInStyleIds.has(sel.id)) referencedStyleIds.add(sel.id);
		}
	}

	// Resolve custom definitions (orphan references silently omitted)
	const roleMap = new Map(customRoles.map((r) => [r.id, r]));
	const styleMap = new Map(customStyles.map((s) => [s.id, s]));

	const bundledRoles = [...referencedRoleIds]
		.map((id) => roleMap.get(id))
		.filter((r): r is RoleDefinition => r != null)
		.map((r) => ({ ...r, builtIn: false }));

	const bundledStyles = [...referencedStyleIds]
		.map((id) => styleMap.get(id))
		.filter((s): s is StyleDefinition => s != null)
		.map((s) => ({ ...s, builtIn: false }));

	const bundledTemplates = templates.map((t) => ({ ...t, builtIn: false }));

	return {
		_hermes_bundle_version: BUNDLE_VERSION,
		_hermes_app_version: appVersion,
		_hermes_exported_at: new Date().toISOString(),
		...(bundleName ? { _hermes_bundle_name: bundleName } : {}),
		templates: bundledTemplates,
		roles: bundledRoles,
		styles: bundledStyles,
	};
}

// ── Validation ───────────────────────────────────────────────────────

export function validateBundle(
	data: unknown,
): { valid: true; bundle: PromptBundle } | { valid: false; error: string } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { valid: false, error: "Invalid bundle file: not a JSON object" };
	}

	const obj = data as Record<string, unknown>;

	// Version check
	if (typeof obj._hermes_bundle_version !== "number") {
		return { valid: false, error: "This file does not appear to be a Hermes prompt bundle" };
	}
	if (obj._hermes_bundle_version > BUNDLE_VERSION) {
		return {
			valid: false,
			error: "This bundle was created by a newer version of Hermes. Please update the app to import it.",
		};
	}

	// Templates array required
	if (!Array.isArray(obj.templates) || obj.templates.length === 0) {
		return { valid: false, error: "Bundle contains no templates" };
	}

	// Basic shape validation for templates
	for (const tpl of obj.templates) {
		if (typeof tpl !== "object" || tpl === null) {
			return { valid: false, error: "Bundle contains an invalid template entry" };
		}
		const t = tpl as Record<string, unknown>;
		if (typeof t.id !== "string" || typeof t.name !== "string") {
			return { valid: false, error: "Bundle contains a template missing id or name" };
		}
	}

	// Roles and styles are optional arrays
	if (obj.roles !== undefined && !Array.isArray(obj.roles)) {
		return { valid: false, error: "Bundle roles field is not an array" };
	}
	if (obj.styles !== undefined && !Array.isArray(obj.styles)) {
		return { valid: false, error: "Bundle styles field is not an array" };
	}

	return {
		valid: true,
		bundle: {
			_hermes_bundle_version: obj._hermes_bundle_version as number,
			_hermes_app_version: (obj._hermes_app_version as string) ?? "",
			_hermes_exported_at: (obj._hermes_exported_at as string) ?? "",
			...(typeof obj._hermes_bundle_name === "string" ? { _hermes_bundle_name: obj._hermes_bundle_name } : {}),
			templates: obj.templates as PromptTemplate[],
			roles: (obj.roles as RoleDefinition[]) ?? [],
			styles: (obj.styles as StyleDefinition[]) ?? [],
		},
	};
}

// ── Import ───────────────────────────────────────────────────────────

/**
 * Merge a validated bundle into the user's existing data.
 * Returns updated arrays and an import result summary.
 *
 * Strategy:
 * - Roles/styles: deduplicate by label (case-insensitive). If match found,
 *   reuse existing ID. Otherwise add with a regenerated ID.
 * - Templates: compare by content fingerprint against ALL existing +
 *   built-in templates (not just ones with the same name — a template
 *   previously auto-renamed to avoid a collision must still be found), AND
 *   by name (case-insensitive).
 *   - Fingerprint matches any existing template: silently skip (true
 *     duplicate), regardless of name.
 *   - Fingerprint matches nothing, but the name collides: auto-rename to
 *     "Name (2)" (or the next free integer suffix) and import — preserves
 *     the incoming content instead of silently dropping it.
 *   - Fingerprint matches nothing and no name collision: add as-is.
 *   All role/style refs are remapped in every case.
 */
export function importBundle(
	bundle: PromptBundle,
	existingTemplates: PromptTemplate[],
	existingRoles: RoleDefinition[],
	existingStyles: StyleDefinition[],
	builtInRoleIds: Set<string>,
	builtInStyleIds: Set<string>,
	builtInTemplates: PromptTemplate[] = [],
	defaultGroup?: string,
): {
	templates: PromptTemplate[];
	roles: RoleDefinition[];
	styles: StyleDefinition[];
	result: BundleImportResult;
} {
	const now = Date.now();
	const result: BundleImportResult = {
		templatesAdded: 0,
		templatesSkipped: 0,
		templatesSkippedRoleStyleDiff: 0,
		templatesRenamed: 0,
		rolesAdded: 0,
		stylesAdded: 0,
	};

	// ── Step 1: Import roles ──────────────────────────────────────────
	const existingRolesByLabel = new Map(
		existingRoles.map((r) => [r.label.toLowerCase(), r]),
	);
	const roleIdMap = new Map<string, string>(); // old bundle ID → new/existing ID
	const newRoles = [...existingRoles];

	for (let i = 0; i < bundle.roles.length; i++) {
		const role = bundle.roles[i];
		const existing = existingRolesByLabel.get(role.label.toLowerCase());
		if (existing) {
			roleIdMap.set(role.id, existing.id);
		} else {
			const newId = `custom-${now}-${i}`;
			roleIdMap.set(role.id, newId);
			newRoles.push({ ...role, id: newId, builtIn: false });
			result.rolesAdded++;
		}
	}

	// ── Step 2: Import styles ─────────────────────────────────────────
	const existingStylesByLabel = new Map(
		existingStyles.map((s) => [s.label.toLowerCase(), s]),
	);
	const styleIdMap = new Map<string, string>();
	const newStyles = [...existingStyles];

	for (let i = 0; i < bundle.styles.length; i++) {
		const style = bundle.styles[i];
		const existing = existingStylesByLabel.get(style.label.toLowerCase());
		if (existing) {
			styleIdMap.set(style.id, existing.id);
		} else {
			const newId = `custom-style-${now}-${i}`;
			styleIdMap.set(style.id, newId);
			newStyles.push({ ...style, id: newId, builtIn: false });
			result.stylesAdded++;
		}
	}

	// ── Step 3: Import templates ──────────────────────────────────────
	// Two independent indexes over existing + built-in templates: by
	// normalized name (for collision detection and picking a rename), and
	// by content fingerprint (for true-duplicate detection, regardless of
	// name — see templateFingerprint()'s doc comment for why that matters).
	const nameKey = (n: string) => n.trim().toLowerCase();
	const existingByName = new Map<string, PromptTemplate[]>();
	const existingByFingerprint = new Map<string, PromptTemplate>();
	for (const t of [...existingTemplates, ...builtInTemplates]) {
		const key = nameKey(t.name);
		const list = existingByName.get(key);
		if (list) list.push(t);
		else existingByName.set(key, [t]);
		existingByFingerprint.set(templateFingerprint(t), t);
	}
	const newTemplates = [...existingTemplates];

	for (let i = 0; i < bundle.templates.length; i++) {
		const tpl = bundle.templates[i];

		const newId = `user-${now}-${i}`;
		const remapped: PromptTemplate = {
			...tpl,
			id: newId,
			builtIn: false,
			group: tpl.group ?? defaultGroup,
			fields: {
				...tpl.fields,
				roleIds: (tpl.fields?.roleIds ?? []).map((id) => remapId(id, roleIdMap, builtInRoleIds)),
				styleSelections: (tpl.fields?.styleSelections ?? []).map((sel) => ({
					...sel,
					id: remapId(sel.id, styleIdMap, builtInStyleIds),
				})),
			},
			recommendedRoles: (tpl.recommendedRoles ?? []).map((id) => remapId(id, roleIdMap, builtInRoleIds)),
			recommendedStyles: (tpl.recommendedStyles ?? []).map((sel) => ({
				...sel,
				id: remapId(sel.id, styleIdMap, builtInStyleIds),
			})),
		};

		const incomingFp = templateFingerprint(remapped);
		const fingerprintMatch = existingByFingerprint.get(incomingFp);
		if (fingerprintMatch) {
			result.templatesSkipped++;
			if (rolesOrStylesDiffer(remapped, fingerprintMatch)) {
				result.templatesSkippedRoleStyleDiff++;
			}
			continue;
		}

		const collisions = existingByName.get(nameKey(tpl.name));
		if (collisions && collisions.length > 0) {
			// No fingerprint match anywhere, but the name is taken: a real
			// content change. Keep the user's content by renaming instead of
			// silently overwriting or dropping it.
			remapped.name = nextAvailableName(tpl.name.trim(), existingByName);
			result.templatesRenamed++;
		}

		newTemplates.push(remapped);
		const finalKey = nameKey(remapped.name);
		const list = existingByName.get(finalKey);
		if (list) list.push(remapped);
		else existingByName.set(finalKey, [remapped]);
		existingByFingerprint.set(incomingFp, remapped);
		result.templatesAdded++;
	}

	return {
		templates: newTemplates,
		roles: newRoles,
		styles: newStyles,
		result,
	};
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Remap a role/style ID: if it's in the idMap use the mapped value,
 *  if it's a built-in pass through unchanged, otherwise pass through as-is. */
function remapId(
	id: string,
	idMap: Map<string, string>,
	builtInIds: Set<string>,
): string {
	if (builtInIds.has(id)) return id;
	return idMap.get(id) ?? id;
}

/** Deterministic fingerprint of a template's substantive prose content, used
 *  to decide whether an incoming template is a true duplicate of ANY
 *  existing template (skip) or a real content change that should be
 *  preserved (by adding it, renaming first if its name collides).
 *
 *  `name` is deliberately excluded: a template that was previously imported
 *  and auto-renamed to avoid a name collision (e.g. "Name (2)") must still
 *  fingerprint-match the same content coming in again under its original
 *  name "Name", or re-importing the same bundle would rename it again on
 *  every pass ("Name (3)", "Name (4)", ...). Only user-authored prose is
 *  otherwise fingerprinted (category, description, task, scope,
 *  constraints, style); identity-only fields (id, builtIn, group) are
 *  excluded too. Role/style ID arrays are also excluded: those IDs get
 *  regenerated on every import, so two semantically-equivalent templates
 *  would otherwise fingerprint differently after one round trip. The
 *  trade-off is that two templates that differ ONLY in which roles/styles
 *  they reference will be treated as duplicates and skipped — the import
 *  summary separately reports how many skips had a roles/styles diff (see
 *  `rolesOrStylesDiffer`) so that isn't silently lost. */
function templateFingerprint(tpl: PromptTemplate): string {
	const stable = {
		category: tpl.category ?? "",
		description: tpl.description ?? "",
		task: tpl.fields?.task ?? "",
		scope: tpl.fields?.scope ?? "",
		constraints: tpl.fields?.constraints ?? "",
		style: tpl.fields?.style ?? "",
	};
	return JSON.stringify(stable);
}

/** True when two templates whose fingerprints already match (identical
 *  prose) differ in the role/style *selections* they carry.
 *  `templateFingerprint()` deliberately ignores these fields (their IDs get
 *  regenerated on every import), so a duplicate-by-content skip can still
 *  silently drop a genuine roles/styles change — this lets the import
 *  summary flag that instead of hiding it entirely. Compares `a` (already
 *  remapped into the target app's role/style ID space) against `b` (an
 *  existing template, which is already in that space natively). */
function rolesOrStylesDiffer(a: PromptTemplate, b: PromptTemplate): boolean {
	const idSet = (ids: string[] | undefined) => new Set(ids ?? []);
	const styleIdSet = (sels: { id: string }[] | undefined) => new Set((sels ?? []).map((s) => s.id));
	const setsEqual = (x: Set<string>, y: Set<string>) =>
		x.size === y.size && [...x].every((v) => y.has(v));

	return (
		!setsEqual(idSet(a.fields?.roleIds), idSet(b.fields?.roleIds)) ||
		!setsEqual(idSet(a.recommendedRoles), idSet(b.recommendedRoles)) ||
		!setsEqual(styleIdSet(a.fields?.styleSelections), styleIdSet(b.fields?.styleSelections)) ||
		!setsEqual(styleIdSet(a.recommendedStyles), styleIdSet(b.recommendedStyles))
	);
}

/** Pick the first unused "Name (N)" suffix for a template whose base name
 *  is already taken by a different-content template. Starts at (2). */
function nextAvailableName(
	baseName: string,
	existingByName: Map<string, PromptTemplate[]>,
): string {
	for (let n = 2; n < 1000; n++) {
		const candidate = `${baseName} (${n})`;
		if (!existingByName.has(candidate.trim().toLowerCase())) return candidate;
	}
	// Pathological fallback: use timestamp to guarantee uniqueness.
	return `${baseName} (${Date.now()})`;
}
