// ─── Rendering an entry with its arguments ───────────────────────────
//
// One render path for everything Hermes sends: @hermes-hq/hodios-core
// (`pasteText`: arguments filled, optional sections dropped when empty,
// workflow steps inlined, a style at its level, a persona as a role). The
// core loads on demand, the first time an entry is opened.

import type { EntryArg, EntryBody } from "./types";

type Core = typeof import("@hermes-hq/hodios-core/compile");

let corePromise: Promise<Core> | null = null;

export function loadCore(): Promise<Core> {
  corePromise ??= import("@hermes-hq/hodios-core/compile");
  return corePromise;
}

export function argsOf(body: EntryBody | null | undefined): EntryArg[] {
  return Array.isArray(body?.fm.args) ? body.fm.args : [];
}

/** Arguments a person must fill before the entry can be used. */
export function missingRequired(body: EntryBody | null | undefined, values: Record<string, string>): string[] {
  return argsOf(body)
    .filter((a) => a.required && a.default === undefined && !(values[a.name] ?? "").trim())
    .map((a) => a.name);
}

/** Starting values: each argument's default. */
export function defaultValues(body: EntryBody | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argsOf(body)) {
    if (a.default !== undefined) out[a.name] = String(a.default);
  }
  return out;
}

/** The text an agent receives (hodios-core `pasteText`). */
export function renderWith(core: Core, body: EntryBody, values: Record<string, string>, level?: number): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v.trim() !== "") clean[k] = v;
  // ResolvedEntry's frontmatter type is stricter than what a row carries.
  return core.pasteText(body as never, clean, level ? { level } : {}).trimEnd();
}

export async function render(body: EntryBody, values: Record<string, string>, level?: number): Promise<string> {
  return renderWith(await loadCore(), body, values, level);
}
