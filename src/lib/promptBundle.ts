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
 * - Templates: compare by name (case-insensitive) AND content fingerprint.
 *   - Name match + fingerprint match: silently skip (true duplicate).
 *   - Name match + fingerprint differs: auto-rename to "Name (2)" (or the
 *     next free integer suffix) and import — preserves the incoming content
 *     instead of silently dropping it.
 *   - No name match: add with a regenerated ID.
 *   All role/style refs are remapped in either case.
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
	// Index existing templates (user + built-in) by normalized name so we
	// can detect collisions and, when needed, compare content fingerprints
	// to decide skip-vs-rename.
	const nameKey = (n: string) => n.trim().toLowerCase();
	const existingByName = new Map<string, PromptTemplate[]>();
	for (const t of [...existingTemplates, ...builtInTemplates]) {
		const key = nameKey(t.name);
		const list = existingByName.get(key);
		if (list) list.push(t);
		else existingByName.set(key, [t]);
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

		const collisions = existingByName.get(nameKey(tpl.name));
		if (collisions && collisions.length > 0) {
			const incomingFp = templateFingerprint(remapped);
			const isTrueDuplicate = collisions.some(
				(existing) => templateFingerprint(existing) === incomingFp,
			);
			if (isTrueDuplicate) {
				result.templatesSkipped++;
				continue;
			}
			// Same name, different body: keep the user's content by renaming.
			remapped.name = nextAvailableName(tpl.name.trim(), existingByName);
			result.templatesRenamed++;
		}

		newTemplates.push(remapped);
		const finalKey = nameKey(remapped.name);
		const list = existingByName.get(finalKey);
		if (list) list.push(remapped);
		else existingByName.set(finalKey, [remapped]);
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
 *  to decide whether a name collision is a true duplicate (skip) or a real
 *  content change that should be preserved by renaming.
 *
 *  Only user-authored prose is fingerprinted (name, category, description,
 *  task, scope, constraints, style). Identity-only fields (id, builtIn,
 *  group) are excluded, and role/style ID arrays are deliberately excluded
 *  too: those IDs get regenerated on every import, so two semantically-
 *  equivalent templates would otherwise fingerprint differently after one
 *  round trip. The trade-off is that two templates that differ ONLY in
 *  which roles/styles they reference will be treated as duplicates — that
 *  is acceptable because it matches the user's intuition of "same template"
 *  and the import path already remaps those references on each pass. */
function templateFingerprint(tpl: PromptTemplate): string {
	const stable = {
		name: tpl.name.trim().toLowerCase(),
		category: tpl.category ?? "",
		description: (tpl as { description?: string }).description ?? "",
		task: tpl.fields?.task ?? "",
		scope: tpl.fields?.scope ?? "",
		constraints: tpl.fields?.constraints ?? "",
		style: tpl.fields?.style ?? "",
	};
	return JSON.stringify(stable);
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
