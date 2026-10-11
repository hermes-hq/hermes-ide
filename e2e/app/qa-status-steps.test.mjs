// block() (qa-status-steps.mjs) on a timeout: the error says how far the
// permission request got, so a one-off CI failure can be told apart (the key
// never arrived, the hook failed or timed out, or the status was replaced).
import { describe, expect, it } from "vitest";
import { block } from "./qa-status-steps.mjs";

describe("block", () => {
  it("adds the session's state and the fake agents' last events and hooks to a timeout", async () => {
    const scripts = [];
    const bridge = {
      eval: async (script) => {
        scripts.push(script);
        return script.includes("write_to_session") ? true : { status: { kind: "idle" }, terminal: ["$ claude"], events: [{ kind: "session_start" }] };
      },
      waitFor: async () => {
        throw new Error("timed out after 15000 ms waiting for: needs approval (last value: false)");
      },
    };
    const fx = {
      records: () => [{ pid: 7, cwd: "/repo", events: [{ ev: "hooks", event: "PermissionRequest" }], hooksRan: [{ event: "PermissionRequest", results: [{ code: null, ms: 5000, stderr: "" }] }] }],
    };
    const err = await block(bridge, "s-3", fx).catch((e) => e);
    expect(err.message).toContain("waiting for: needs approval");
    expect(err.message).toContain('session s-3: {"status":{"kind":"idle"},"terminal":["$ claude"],"events":[{"kind":"session_start"}]}');
    expect(err.message).toContain('"hooks":[{"event":"PermissionRequest","results":[{"code":null,"ms":5000,"stderr":""}]}]');
    expect(err.stack).toContain("session s-3");
  });

  it("still fails with the original timeout when the app cannot answer", async () => {
    const bridge = {
      eval: async (script) => {
        if (script.includes("write_to_session")) return true;
        throw new Error("fetch failed");
      },
      waitFor: async () => {
        throw new Error("timed out after 15000 ms waiting for: needs approval (last value: false)");
      },
    };
    const err = await block(bridge, "s-1").catch((e) => e);
    expect(err.message).toContain("waiting for: needs approval");
    expect(err.message).toContain("session s-1: \"unavailable: fetch failed\"");
    expect(err.message).toContain('fake agents: "not asked"');
  });
});
