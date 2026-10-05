// The kind tile of a Prompts row: tasks (prompts and workflows), personas
// and answer styles each have one drawn glyph, so a row is told apart by
// shape as well as colour.

import type { EntryKind } from "../../library/types";

export function KindIcon({ kind }: { kind: EntryKind }) {
  return (
    <span className="pp-kind" data-kind={kind === "workflow" ? "workflow" : kind === "persona" || kind === "style" ? kind : "prompt"} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {kind === "workflow" ? (
          <>
            <circle cx="4" cy="4" r="1.6" />
            <circle cx="4" cy="12" r="1.6" />
            <path d="M8 4h5M8 12h5M4 6v4" />
          </>
        ) : kind === "persona" ? (
          <>
            <circle cx="8" cy="5.5" r="2.6" />
            <path d="M3 13.5c.8-2.6 2.8-3.8 5-3.8s4.2 1.2 5 3.8" />
          </>
        ) : kind === "style" ? (
          <path d="M2.5 13 5.5 3.5h1L9.5 13M3.6 10h4.8M11 9.5c0-1 .8-1.6 1.8-1.6s1.7.6 1.7 1.6V13M14.5 11.2c-2.2 0-3.5.4-3.5 1.1 0 .5.4.8 1.1.8 1.4 0 2.4-.9 2.4-1.9" />
        ) : (
          <path d="M3 4h10M3 8h10M3 12h6" />
        )}
      </svg>
    </span>
  );
}
