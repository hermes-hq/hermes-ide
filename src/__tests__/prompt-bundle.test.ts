import { describe, it, expect } from "vitest";
import {
	createBundle,
	validateBundle,
	importBundle,
	type PromptBundle,
} from "../lib/promptBundle";
import type { PromptTemplate } from "../lib/templates";
import type { RoleDefinition } from "../lib/roles";
import type { StyleDefinition, SelectedStyle } from "../lib/styles";

// ── Helpers ──────────────────────────────────────────────────────────

const BUILT_IN_ROLE_IDS = new Set(["backend-eng", "frontend-eng", "debugger"]);
const BUILT_IN_STYLE_IDS = new Set(["concise", "detailed", "code-heavy"]);

function makeRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
	return {
		id: "custom-role-1",
		label: "My Custom Role",
		description: "A custom role",
		systemInstruction: "You are a custom role.",
		builtIn: false,
		...overrides,
	};
}

function makeStyle(overrides: Partial<StyleDefinition> = {}): StyleDefinition {
	return {
		id: "custom-style-1",
		label: "My Custom Style",
		description: "A custom style",
		levels: ["L1", "L2", "L3", "L4", "L5"],
		builtIn: false,
		...overrides,
	};
}

function makeTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
	return {
		id: "user-1000",
		name: "Test Template",
		category: "debugging",
		fields: {
			roleIds: ["custom-role-1"],
			task: "Fix the bug",
			scope: "src/",
			constraints: "",
			styleSelections: [{ id: "custom-style-1", level: 3 }],
			style: "",
		},
		recommendedRoles: ["custom-role-1"],
		recommendedStyles: [{ id: "custom-style-1", level: 3 }],
		builtIn: false,
		...overrides,
	};
}

// ── createBundle ─────────────────────────────────────────────────────

describe("createBundle", () => {
	it("creates a valid bundle with metadata", () => {
		const tpl = makeTemplate();
		const role = makeRole();
		const style = makeStyle();

		const bundle = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "0.6.4");

		expect(bundle._hermes_bundle_version).toBe(1);
		expect(bundle._hermes_app_version).toBe("0.6.4");
		expect(bundle._hermes_exported_at).toBeTruthy();
		expect(bundle.templates).toHaveLength(1);
		expect(bundle.templates[0].name).toBe("Test Template");
		expect(bundle.templates[0].builtIn).toBe(false);
	});

	it("includes only custom roles/styles referenced by templates", () => {
		const role1 = makeRole({ id: "custom-role-1", label: "Role 1" });
		const role2 = makeRole({ id: "custom-role-2", label: "Role 2" });
		const style1 = makeStyle({ id: "custom-style-1", label: "Style 1" });
		const style2 = makeStyle({ id: "custom-style-2", label: "Style 2" });

		// Template only references role-1 and style-1
		const tpl = makeTemplate({
			fields: {
				roleIds: ["custom-role-1"],
				task: "task",
				scope: "",
				constraints: "",
				styleSelections: [{ id: "custom-style-1", level: 2 }],
				style: "",
			},
			recommendedRoles: [],
			recommendedStyles: [],
		});

		const bundle = createBundle([tpl], [role1, role2], [style1, style2], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		expect(bundle.roles).toHaveLength(1);
		expect(bundle.roles[0].id).toBe("custom-role-1");
		expect(bundle.styles).toHaveLength(1);
		expect(bundle.styles[0].id).toBe("custom-style-1");
	});

	it("excludes built-in roles/styles from the bundle", () => {
		const tpl = makeTemplate({
			fields: {
				roleIds: ["backend-eng", "custom-role-1"],
				task: "task",
				scope: "",
				constraints: "",
				styleSelections: [
					{ id: "concise", level: 3 },
					{ id: "custom-style-1", level: 2 },
				],
				style: "",
			},
			recommendedRoles: ["debugger"],
			recommendedStyles: [{ id: "detailed", level: 4 }],
		});
		const role = makeRole();
		const style = makeStyle();

		const bundle = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		// Should only include the custom ones, not backend-eng/concise/debugger/detailed
		expect(bundle.roles).toHaveLength(1);
		expect(bundle.roles[0].id).toBe("custom-role-1");
		expect(bundle.styles).toHaveLength(1);
		expect(bundle.styles[0].id).toBe("custom-style-1");
	});

	it("silently omits orphaned custom role/style references", () => {
		const tpl = makeTemplate({
			fields: {
				roleIds: ["custom-deleted-role"],
				task: "task",
				scope: "",
				constraints: "",
				styleSelections: [{ id: "custom-deleted-style", level: 1 }],
				style: "",
			},
			recommendedRoles: [],
			recommendedStyles: [],
		});

		const bundle = createBundle([tpl], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		expect(bundle.roles).toHaveLength(0);
		expect(bundle.styles).toHaveLength(0);
		expect(bundle.templates).toHaveLength(1);
	});

	it("collects dependencies from recommendedRoles and recommendedStyles", () => {
		const role = makeRole({ id: "custom-rec-role", label: "Recommended Role" });
		const style = makeStyle({ id: "custom-rec-style", label: "Recommended Style" });

		const tpl = makeTemplate({
			fields: { roleIds: [], task: "task", scope: "", constraints: "", styleSelections: [], style: "" },
			recommendedRoles: ["custom-rec-role"],
			recommendedStyles: [{ id: "custom-rec-style", level: 5 }],
		});

		const bundle = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		expect(bundle.roles).toHaveLength(1);
		expect(bundle.roles[0].id).toBe("custom-rec-role");
		expect(bundle.styles).toHaveLength(1);
		expect(bundle.styles[0].id).toBe("custom-rec-style");
	});

	it("deduplicates role/style references across multiple templates", () => {
		const role = makeRole({ id: "shared-role", label: "Shared Role" });
		const style = makeStyle({ id: "shared-style", label: "Shared Style" });

		const tpl1 = makeTemplate({
			id: "user-1",
			name: "Template 1",
			fields: { roleIds: ["shared-role"], task: "t1", scope: "", constraints: "", styleSelections: [{ id: "shared-style", level: 1 }], style: "" },
			recommendedRoles: [],
			recommendedStyles: [],
		});
		const tpl2 = makeTemplate({
			id: "user-2",
			name: "Template 2",
			fields: { roleIds: ["shared-role"], task: "t2", scope: "", constraints: "", styleSelections: [{ id: "shared-style", level: 4 }], style: "" },
			recommendedRoles: [],
			recommendedStyles: [],
		});

		const bundle = createBundle([tpl1, tpl2], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		expect(bundle.templates).toHaveLength(2);
		expect(bundle.roles).toHaveLength(1);
		expect(bundle.styles).toHaveLength(1);
	});

	it("handles templates with no fields gracefully", () => {
		const tpl = makeTemplate({
			fields: {},
			recommendedRoles: [],
			recommendedStyles: [],
		});

		const bundle = createBundle([tpl], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "1.0.0");

		expect(bundle.templates).toHaveLength(1);
		expect(bundle.roles).toHaveLength(0);
		expect(bundle.styles).toHaveLength(0);
	});
});

// ── validateBundle ───────────────────────────────────────────────────

describe("validateBundle", () => {
	function validBundleData(): Record<string, unknown> {
		return {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "2026-01-01T00:00:00Z",
			templates: [{ id: "user-1", name: "Test", category: "debugging", fields: {}, recommendedRoles: [], recommendedStyles: [], builtIn: false }],
			roles: [],
			styles: [],
		};
	}

	it("accepts a valid bundle", () => {
		const result = validateBundle(validBundleData());
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.bundle.templates).toHaveLength(1);
		}
	});

	it("rejects non-object input", () => {
		expect(validateBundle(null).valid).toBe(false);
		expect(validateBundle("string").valid).toBe(false);
		expect(validateBundle(42).valid).toBe(false);
		expect(validateBundle([]).valid).toBe(false);
		expect(validateBundle(undefined).valid).toBe(false);
	});

	it("rejects missing _hermes_bundle_version", () => {
		const data = validBundleData();
		delete data._hermes_bundle_version;
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("does not appear to be");
		}
	});

	it("rejects future bundle version", () => {
		const data = validBundleData();
		data._hermes_bundle_version = 99;
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("newer version");
		}
	});

	it("rejects empty templates array", () => {
		const data = validBundleData();
		data.templates = [];
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("no templates");
		}
	});

	it("rejects missing templates field", () => {
		const data = validBundleData();
		delete data.templates;
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
	});

	it("rejects template without id", () => {
		const data = validBundleData();
		data.templates = [{ name: "No ID" }];
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("missing id or name");
		}
	});

	it("rejects template without name", () => {
		const data = validBundleData();
		data.templates = [{ id: "user-1" }];
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("missing id or name");
		}
	});

	it("rejects non-array roles field", () => {
		const data = validBundleData();
		data.roles = "not-an-array";
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("roles");
		}
	});

	it("rejects non-array styles field", () => {
		const data = validBundleData();
		data.styles = 42;
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("styles");
		}
	});

	it("defaults missing roles and styles to empty arrays", () => {
		const data = validBundleData();
		delete data.roles;
		delete data.styles;
		const result = validateBundle(data);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.bundle.roles).toEqual([]);
			expect(result.bundle.styles).toEqual([]);
		}
	});

	it("defaults missing app_version and exported_at to empty strings", () => {
		const data = validBundleData();
		delete data._hermes_app_version;
		delete data._hermes_exported_at;
		const result = validateBundle(data);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.bundle._hermes_app_version).toBe("");
			expect(result.bundle._hermes_exported_at).toBe("");
		}
	});

	it("rejects template entry that is null", () => {
		const data = validBundleData();
		data.templates = [null];
		const result = validateBundle(data);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("invalid template entry");
		}
	});
});

// ── importBundle ─────────────────────────────────────────────────────

describe("importBundle", () => {
	function makeBundleWithDeps(): PromptBundle {
		return {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "2026-01-01T00:00:00Z",
			templates: [makeTemplate()],
			roles: [makeRole()],
			styles: [makeStyle()],
		};
	}

	it("imports templates, roles, and styles into empty collections", () => {
		const bundle = makeBundleWithDeps();
		const { templates, roles, styles, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.templatesSkipped).toBe(0);
		expect(result.rolesAdded).toBe(1);
		expect(result.stylesAdded).toBe(1);
		expect(templates).toHaveLength(1);
		expect(roles).toHaveLength(1);
		expect(styles).toHaveLength(1);
	});

	it("regenerates all IDs on import", () => {
		const bundle = makeBundleWithDeps();
		const { templates, roles, styles } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		// IDs should be regenerated (not the originals)
		expect(templates[0].id).not.toBe("user-1000");
		expect(templates[0].id).toMatch(/^user-\d+-\d+$/);
		expect(roles[0].id).not.toBe("custom-role-1");
		expect(roles[0].id).toMatch(/^custom-\d+-\d+$/);
		expect(styles[0].id).not.toBe("custom-style-1");
		expect(styles[0].id).toMatch(/^custom-style-\d+-\d+$/);
	});

	it("remaps role/style references in imported templates", () => {
		const bundle = makeBundleWithDeps();
		const { templates, roles, styles } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		// The template's roleIds should point to the new role ID
		const newRoleId = roles[0].id;
		const newStyleId = styles[0].id;
		expect(templates[0].fields?.roleIds).toContain(newRoleId);
		expect(templates[0].fields?.styleSelections?.[0]?.id).toBe(newStyleId);
		expect(templates[0].recommendedRoles).toContain(newRoleId);
		expect(templates[0].recommendedStyles?.[0]?.id).toBe(newStyleId);
	});

	it("deduplicates roles by label (case-insensitive) and reuses existing ID", () => {
		const existingRole = makeRole({ id: "existing-role-id", label: "My Custom Role" });
		const bundle = makeBundleWithDeps(); // has role with label "My Custom Role"

		const { templates, roles, result } = importBundle(
			bundle, [], [existingRole], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.rolesAdded).toBe(0);
		expect(roles).toHaveLength(1); // no new role added
		expect(roles[0].id).toBe("existing-role-id");
		// Template should reference the existing role's ID
		expect(templates[0].fields?.roleIds).toContain("existing-role-id");
	});

	it("deduplicates styles by label (case-insensitive) and reuses existing ID", () => {
		const existingStyle = makeStyle({ id: "existing-style-id", label: "my custom style" }); // lowercase
		const bundle = makeBundleWithDeps(); // has style with label "My Custom Style"

		const { templates, styles, result } = importBundle(
			bundle, [], [], [existingStyle], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.stylesAdded).toBe(0);
		expect(styles).toHaveLength(1);
		expect(styles[0].id).toBe("existing-style-id");
		expect(templates[0].fields?.styleSelections?.[0]?.id).toBe("existing-style-id");
	});

	it("skips templates with duplicate names (case-insensitive)", () => {
		const existingTemplate = makeTemplate({ id: "existing-tpl", name: "test template" }); // lowercase
		const bundle = makeBundleWithDeps(); // has template named "Test Template"

		const { templates, result } = importBundle(
			bundle, [existingTemplate], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(0);
		expect(result.templatesSkipped).toBe(1);
		expect(templates).toHaveLength(1);
		expect(templates[0].id).toBe("existing-tpl"); // kept the existing one
	});

	it("preserves existing data when importing", () => {
		const existingTemplate = makeTemplate({ id: "existing-1", name: "Existing Template" });
		const existingRole = makeRole({ id: "existing-role", label: "Existing Role" });
		const existingStyle = makeStyle({ id: "existing-style", label: "Existing Style" });

		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({ id: "new-1", name: "New Template" })],
			roles: [makeRole({ id: "new-role", label: "New Role" })],
			styles: [makeStyle({ id: "new-style", label: "New Style" })],
		};

		const { templates, roles, styles } = importBundle(
			bundle, [existingTemplate], [existingRole], [existingStyle], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(templates).toHaveLength(2);
		expect(templates[0].id).toBe("existing-1");
		expect(roles).toHaveLength(2);
		expect(roles[0].id).toBe("existing-role");
		expect(styles).toHaveLength(2);
		expect(styles[0].id).toBe("existing-style");
	});

	it("handles built-in role/style references in templates (pass through unchanged)", () => {
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({
				fields: {
					roleIds: ["backend-eng"],
					task: "task",
					scope: "",
					constraints: "",
					styleSelections: [{ id: "concise", level: 3 }],
					style: "",
				},
				recommendedRoles: ["debugger"],
				recommendedStyles: [{ id: "detailed", level: 2 }],
			})],
			roles: [],
			styles: [],
		};

		const { templates } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(templates[0].fields?.roleIds).toContain("backend-eng");
		expect(templates[0].fields?.styleSelections?.[0]?.id).toBe("concise");
		expect(templates[0].recommendedRoles).toContain("debugger");
		expect(templates[0].recommendedStyles?.[0]?.id).toBe("detailed");
	});

	it("handles bundle with empty roles and styles arrays", () => {
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({
				fields: { roleIds: [], task: "simple task", scope: "", constraints: "", styleSelections: [], style: "" },
				recommendedRoles: [],
				recommendedStyles: [],
			})],
			roles: [],
			styles: [],
		};

		const { templates, roles, styles, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.rolesAdded).toBe(0);
		expect(result.stylesAdded).toBe(0);
		expect(templates).toHaveLength(1);
		expect(roles).toHaveLength(0);
		expect(styles).toHaveLength(0);
	});

	it("imports multiple templates from a single bundle", () => {
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [
				makeTemplate({ id: "t1", name: "Template A" }),
				makeTemplate({ id: "t2", name: "Template B" }),
				makeTemplate({ id: "t3", name: "Template C" }),
			],
			roles: [makeRole()],
			styles: [makeStyle()],
		};

		const { templates, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(3);
		expect(templates).toHaveLength(3);
		// All should have unique regenerated IDs
		const ids = new Set(templates.map((t) => t.id));
		expect(ids.size).toBe(3);
	});

	it("skips some and adds others in a mixed import", () => {
		const existing = makeTemplate({ id: "ex-1", name: "Template A" });
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [
				makeTemplate({ id: "t1", name: "Template A" }), // duplicate — skip
				makeTemplate({ id: "t2", name: "Template B" }), // new — add
			],
			roles: [],
			styles: [],
		};

		const { templates, result } = importBundle(
			bundle, [existing], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.templatesSkipped).toBe(1);
		expect(templates).toHaveLength(2);
		expect(templates[0].name).toBe("Template A"); // existing kept
		expect(templates[1].name).toBe("Template B"); // new added
	});

	it("skips templates that match built-in template names", () => {
		const builtInTemplates = [
			makeTemplate({ id: "builtin-1", name: "Code Review", builtIn: true }),
			makeTemplate({ id: "builtin-2", name: "Bug Report", builtIn: true }),
		];
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [
				makeTemplate({ id: "t1", name: "Code Review" }), // matches built-in — skip
				makeTemplate({ id: "t2", name: "New Template" }), // unique — add
			],
			roles: [],
			styles: [],
		};

		const { templates, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, builtInTemplates,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.templatesSkipped).toBe(1);
		expect(templates).toHaveLength(1);
		expect(templates[0].name).toBe("New Template");
	});

	it("skips built-in name matches case-insensitively", () => {
		const builtInTemplates = [
			makeTemplate({ id: "builtin-1", name: "Code Review", builtIn: true }),
		];
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({ id: "t1", name: "code review" })],
			roles: [],
			styles: [],
		};

		const { result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, builtInTemplates,
		);

		expect(result.templatesAdded).toBe(0);
		expect(result.templatesSkipped).toBe(1);
	});

	it("deduplicates against both user and built-in templates", () => {
		const builtInTemplates = [
			makeTemplate({ id: "builtin-1", name: "Built-in Template", builtIn: true }),
		];
		const existingUser = makeTemplate({ id: "user-existing", name: "User Template" });
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [
				makeTemplate({ id: "t1", name: "Built-in Template" }), // matches built-in
				makeTemplate({ id: "t2", name: "User Template" }),     // matches user
				makeTemplate({ id: "t3", name: "Brand New" }),         // unique
			],
			roles: [],
			styles: [],
		};

		const { templates, result } = importBundle(
			bundle, [existingUser], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, builtInTemplates,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.templatesSkipped).toBe(2);
		expect(templates).toHaveLength(2); // existing user + brand new
		expect(templates[0].name).toBe("User Template");
		expect(templates[1].name).toBe("Brand New");
	});

	it("works without builtInTemplates param (backward compat)", () => {
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({ id: "t1", name: "New One" })],
			roles: [],
			styles: [],
		};

		const { templates, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(templates).toHaveLength(1);
	});

	it("handles template with missing fields gracefully", () => {
		const bundle: PromptBundle = {
			_hermes_bundle_version: 1,
			_hermes_app_version: "0.6.4",
			_hermes_exported_at: "",
			templates: [makeTemplate({
				fields: {},
				recommendedRoles: [],
				recommendedStyles: [],
			})],
			roles: [],
			styles: [],
		};

		const { templates, result } = importBundle(
			bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(templates[0].fields?.roleIds).toEqual([]);
		expect(templates[0].fields?.styleSelections).toEqual([]);
	});
});

// ── Round-trip ───────────────────────────────────────────────────────

describe("round-trip: export then import", () => {
	it("produces equivalent data after export and import", () => {
		const role = makeRole({ id: "custom-role-1", label: "Test Role" });
		const style = makeStyle({ id: "custom-style-1", label: "Test Style" });
		const tpl = makeTemplate({
			name: "Round Trip Template",
			fields: {
				roleIds: ["custom-role-1", "backend-eng"],
				task: "Do the thing",
				scope: "src/",
				constraints: "No deps",
				styleSelections: [
					{ id: "custom-style-1", level: 3 },
					{ id: "concise", level: 2 },
				],
				style: "Be nice",
			},
			recommendedRoles: ["custom-role-1"],
			recommendedStyles: [{ id: "custom-style-1", level: 4 }],
		});

		// Export
		const bundle = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "0.6.4");

		// Validate
		const validation = validateBundle(bundle);
		expect(validation.valid).toBe(true);
		if (!validation.valid) return;

		// Import into empty
		const { templates, roles, styles, result } = importBundle(
			validation.bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(result.rolesAdded).toBe(1);
		expect(result.stylesAdded).toBe(1);

		// Verify content is preserved
		const imported = templates[0];
		expect(imported.name).toBe("Round Trip Template");
		expect(imported.fields?.task).toBe("Do the thing");
		expect(imported.fields?.scope).toBe("src/");
		expect(imported.fields?.constraints).toBe("No deps");
		expect(imported.fields?.style).toBe("Be nice");

		// Built-in references preserved
		expect(imported.fields?.roleIds).toContain("backend-eng");
		expect(imported.fields?.styleSelections?.find((s) => s.id === "concise")).toBeTruthy();

		// Custom references remapped to new IDs
		const newRoleId = roles[0].id;
		const newStyleId = styles[0].id;
		expect(imported.fields?.roleIds).toContain(newRoleId);
		expect(imported.fields?.styleSelections?.find((s) => s.id === newStyleId)).toBeTruthy();
		expect(imported.recommendedRoles).toContain(newRoleId);
		expect(imported.recommendedStyles?.find((s) => s.id === newStyleId)).toBeTruthy();

		// Role/style content preserved
		expect(roles[0].label).toBe("Test Role");
		expect(roles[0].systemInstruction).toBe("You are a custom role.");
		expect(styles[0].label).toBe("Test Style");
		expect(styles[0].levels).toEqual(["L1", "L2", "L3", "L4", "L5"]);
	});

	it("round-trip through JSON serialization works", () => {
		const role = makeRole();
		const style = makeStyle();
		const tpl = makeTemplate();

		const bundle = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "0.6.4");

		// Simulate writing to file and reading back
		const json = JSON.stringify(bundle);
		const parsed = JSON.parse(json);

		const validation = validateBundle(parsed);
		expect(validation.valid).toBe(true);
		if (!validation.valid) return;

		const { templates, result } = importBundle(
			validation.bundle, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		expect(result.templatesAdded).toBe(1);
		expect(templates[0].name).toBe("Test Template");
	});

	it("re-export of imported data produces a valid bundle", () => {
		const role = makeRole();
		const style = makeStyle();
		const tpl = makeTemplate();

		// First export
		const bundle1 = createBundle([tpl], [role], [style], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "0.6.4");

		// Import
		const { templates, roles, styles } = importBundle(
			bundle1, [], [], [], BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS,
		);

		// Re-export
		const bundle2 = createBundle(templates, roles, styles, BUILT_IN_ROLE_IDS, BUILT_IN_STYLE_IDS, "0.6.4");

		expect(validateBundle(bundle2).valid).toBe(true);
		expect(bundle2.templates).toHaveLength(1);
		expect(bundle2.roles).toHaveLength(1);
		expect(bundle2.styles).toHaveLength(1);
	});
});
