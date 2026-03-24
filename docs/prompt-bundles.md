# Prompt Bundles

Prompt bundles let you share custom prompt templates as portable `.hermes-prompts` files. A bundle packages one or more templates together with any custom roles and styles they depend on, so the recipient gets a complete, ready-to-use setup.

## Quick start

1. **Export** -- Open the Prompt Composer, click Templates, and use the arrow icon on any saved template to export it. Or click **Export All** to bundle every saved template at once.
2. **Import** -- Click **Import** in the template picker, select a `.hermes-prompts` file, and your new templates appear instantly.

## File format

A `.hermes-prompts` file is JSON with this structure:

```json
{
  "_hermes_bundle_version": 1,
  "_hermes_app_version": "0.6.4",
  "_hermes_exported_at": "2026-03-24T12:00:00.000Z",
  "templates": [],
  "roles": [],
  "styles": []
}
```

### Metadata fields

| Field | Type | Description |
|---|---|---|
| `_hermes_bundle_version` | `number` | Format version. Currently `1`. |
| `_hermes_app_version` | `string` | App version that created the bundle (informational). |
| `_hermes_exported_at` | `string` | ISO 8601 timestamp (informational). |

### `templates` (required)

An array of template objects. At least one is required.

```json
{
  "id": "user-1711234567890",
  "name": "My API Review Checklist",
  "description": "Step-by-step review for REST API endpoints.",
  "category": "git-review",
  "builtIn": false,
  "fields": {
    "roleIds": ["custom-api-reviewer"],
    "task": "Review this API endpoint for correctness, security, and consistency.",
    "scope": "Focus on the changed files in this PR.",
    "constraints": "Flag any breaking changes. Check auth middleware is applied.",
    "styleSelections": [
      { "id": "concise", "level": 3 },
      { "id": "custom-checklist-style", "level": 4 }
    ],
    "style": ""
  },
  "recommendedRoles": ["custom-api-reviewer"],
  "recommendedStyles": [{ "id": "custom-checklist-style", "level": 4 }]
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier. Regenerated on import to avoid collisions. |
| `name` | `string` | Display name. Used for deduplication on import (case-insensitive). |
| `description` | `string?` | Optional tooltip shown on hover. |
| `category` | `string` | One of: `debugging`, `refactoring`, `performance`, `security`, `testing`, `architecture`, `documentation`, `git-review`, `product`, `planning`, `design`, `devops`, `data`, `ai-ml`, `incident`, `business`, `monetization`, `legal`. |
| `builtIn` | `boolean` | Always `false` in bundles. |
| `fields` | `object` | The template's pre-filled prompt fields (see below). |
| `recommendedRoles` | `string[]` | Role IDs suggested when applying this template. |
| `recommendedStyles` | `SelectedStyle[]` | Style selections suggested when applying this template. |

#### `fields` object

| Field | Type | Description |
|---|---|---|
| `roleIds` | `string[]` | IDs of roles to activate. Can mix built-in IDs (e.g. `"backend-eng"`) and custom IDs. |
| `task` | `string` | Main instruction -- what the AI should do. |
| `scope` | `string` | Boundaries -- files, directories, focus areas. |
| `constraints` | `string` | Rules and limitations. |
| `styleSelections` | `SelectedStyle[]` | Array of `{ id: string, level: number }` where level is 1-5. |
| `style` | `string` | Free-text additional style notes. |

### `roles` (optional)

An array of custom role definitions. Only include roles that your templates reference -- built-in roles (like `"backend-eng"` or `"debugger"`) are already available in every Hermes installation.

```json
{
  "id": "custom-api-reviewer",
  "label": "API Reviewer",
  "description": "Specialized in REST API design and security",
  "systemInstruction": "You are an expert API reviewer focused on REST design patterns, authentication, rate limiting, and backward compatibility.",
  "builtIn": false
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier. Regenerated on import. |
| `label` | `string` | Display name. Used for deduplication on import (case-insensitive). |
| `description` | `string?` | Optional short description. |
| `systemInstruction` | `string` | The system prompt text injected when this role is active. |
| `builtIn` | `boolean` | Always `false` in bundles. |

### `styles` (optional)

An array of custom style definitions with 5 intensity levels.

```json
{
  "id": "custom-checklist-style",
  "label": "Checklist Format",
  "description": "Structures output as actionable checklists",
  "levels": [
    "Include a brief checklist where helpful.",
    "Format key findings as a checklist.",
    "Structure your entire response as a checklist with pass/fail items.",
    "Use a strict checklist format. Every point must be a checkable item.",
    "Output only a checklist. No prose. Every line is a pass/fail item."
  ],
  "builtIn": false
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier. Regenerated on import. |
| `label` | `string` | Display name. Used for deduplication on import (case-insensitive). |
| `description` | `string?` | Optional short description. |
| `levels` | `[string, string, string, string, string]` | Five intensity levels (1 = subtle, 5 = maximum). |
| `builtIn` | `boolean` | Always `false` in bundles. |

## Built-in role and style IDs

When your template references a built-in role or style, use its ID directly -- it will resolve on any Hermes installation. Don't include built-in definitions in the `roles` or `styles` arrays.

**Built-in roles:** `backend-eng`, `frontend-eng`, `fullstack-eng`, `typescript-specialist`, `debugger`, `performance-specialist`, `security-specialist`, `devops-eng`, `code-reviewer`, `technical-writer`, `concurrency-specialist`, `database-specialist`, `rust-specialist`, `systems-eng`, `qa-eng`, `data-eng`, `ml-eng`, `ux-eng`, `accessibility-specialist`, `product-manager`

**Built-in styles:** `concise`, `detailed`, `code-heavy`, `conversational`, `socratic`, `step-by-step`, `visual`, `diff-format`, `eli5`, `formal`, `opinionated`, `cautious`, `creative`, `devil-advocate`, `test-driven`

## Import behavior

When importing a bundle:

- **Roles and styles** are matched by label (case-insensitive). If a role/style with the same name already exists, the existing one is reused. New ones are added.
- **Templates** are matched by name (case-insensitive). If a template with the same name already exists, it is skipped. New ones are added.
- **IDs are always regenerated** on import to avoid collisions. All internal references (template -> role, template -> style) are remapped automatically.
- **Existing data is never overwritten or deleted.** Import is always additive.

## Creating bundles by hand

You can write `.hermes-prompts` files manually or generate them with a script. The minimal valid bundle:

```json
{
  "_hermes_bundle_version": 1,
  "templates": [
    {
      "id": "t1",
      "name": "My Template",
      "category": "debugging",
      "builtIn": false,
      "fields": {
        "task": "Explain this error and suggest a fix."
      },
      "recommendedRoles": [],
      "recommendedStyles": []
    }
  ]
}
```

The `roles` and `styles` arrays can be omitted if your templates only use built-in references. The `_hermes_app_version` and `_hermes_exported_at` metadata fields are optional.

## Example

See [`examples/starter-bundle.hermes-prompts`](examples/starter-bundle.hermes-prompts) for a complete example with custom roles and styles.
