/**
 * `session-metadata-updated` event — emitted by Rust when the
 * agent-mode fallback in `update_session_label/description/color/group`
 * fires (no PtySession to mutate).  The frontend listener merges the
 * partial payload into the existing React session state.
 *
 * This test pins the merge contract.  When the contract drifts, the
 * assertions catch it.
 */
import { describe, it, expect } from "vitest";

interface PartialEvent {
  session_id: string;
  label?: string;
  description?: string;
  color?: string;
  group?: string | null;
}

interface SessionShape {
  id: string;
  label: string;
  description: string;
  color: string;
  group: string | null;
  // … plus many other fields irrelevant to this contract.  The merge
  // path uses spread, so untouched fields are preserved by reference.
  workspace_paths: string[];
}

/** Mirror of the merge logic in SessionContext.tsx::session-metadata-updated
 *  listener.  When the listener changes, change this and let the tests
 *  catch the drift. */
function mergeMetadata(prev: SessionShape, ev: PartialEvent): SessionShape {
  return {
    ...prev,
    ...(ev.label !== undefined ? { label: ev.label } : {}),
    ...(ev.description !== undefined ? { description: ev.description } : {}),
    ...(ev.color !== undefined ? { color: ev.color } : {}),
    ...(ev.group !== undefined ? { group: ev.group ?? null } : {}),
  };
}

const baseSession = (): SessionShape => ({
  id: "sess-agent",
  label: "old",
  description: "old desc",
  color: "#000000",
  group: null,
  workspace_paths: ["/A"],
});

describe("session-metadata-updated merge (sm-1..sm-9 frontend contract)", () => {
  it("sm-1: label-only update preserves description/color/group/workspace_paths", () => {
    const got = mergeMetadata(baseSession(), { session_id: "sess-agent", label: "new" });
    expect(got.label).toBe("new");
    expect(got.description).toBe("old desc");
    expect(got.color).toBe("#000000");
    expect(got.group).toBe(null);
    expect(got.workspace_paths).toEqual(["/A"]);
  });

  it("sm-3: description-only update", () => {
    const got = mergeMetadata(baseSession(), { session_id: "sess-agent", description: "new desc" });
    expect(got.description).toBe("new desc");
    expect(got.label).toBe("old");
  });

  it("sm-4: color-only update", () => {
    const got = mergeMetadata(baseSession(), { session_id: "sess-agent", color: "#ffaa00" });
    expect(got.color).toBe("#ffaa00");
    expect(got.label).toBe("old");
  });

  it("sm-5: group set via string", () => {
    const got = mergeMetadata(baseSession(), { session_id: "sess-agent", group: "workshop" });
    expect(got.group).toBe("workshop");
  });

  it("sm-5-b: group cleared via null", () => {
    const prev = { ...baseSession(), group: "workshop" };
    const got = mergeMetadata(prev, { session_id: "sess-agent", group: null });
    expect(got.group).toBe(null);
  });

  it("payload missing a field → that field is unchanged", () => {
    const prev = { ...baseSession(), color: "#abcdef" };
    const got = mergeMetadata(prev, { session_id: "sess-agent", label: "renamed" });
    expect(got.color).toBe("#abcdef");
    expect(got.label).toBe("renamed");
  });

  it("multiple fields in one event are all merged", () => {
    const got = mergeMetadata(baseSession(), {
      session_id: "sess-agent",
      label: "new",
      description: "new desc",
      color: "#ff0000",
      group: "g1",
    });
    expect(got).toMatchObject({
      label: "new",
      description: "new desc",
      color: "#ff0000",
      group: "g1",
    });
  });

  it("regression guard — empty payload (only session_id) is a no-op", () => {
    const prev = baseSession();
    const got = mergeMetadata(prev, { session_id: "sess-agent" });
    expect(got).toEqual(prev);
  });
});
