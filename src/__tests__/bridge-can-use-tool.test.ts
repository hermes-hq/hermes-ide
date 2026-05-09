/**
 * Bridge `canUseTool` callback regression coverage.
 *
 * Two surfaces under test:
 *
 * 1. `normalizeBridgeAllowDecision`
 *    Regression coverage for the v1 plan-mode "Send does nothing" bug:
 *    the SDK's Zod schema for `canUseTool` allow responses requires
 *    `updatedInput` to be a record on every call.  When the host
 *    approves WITHOUT editing input (e.g. accepting a plan or answering
 *    an AskUserQuestion via the perm-response channel), the bridge must
 *    ECHO the original input back as `updatedInput`.  Skipping the echo
 *    throws `ZodError("expected record, received undefined")` and the
 *    tool call silently fails — the user sees nothing happen.
 *
 * 2. `createCanUseToolHandler`
 *    Regression coverage for the abort-signal hang:
 *    the SDK's 3rd argument exposes an `AbortSignal` that fires when
 *    the agent is aborted (user hits stop, parent context cancels).
 *    The original implementation destructured this as `_meta` and
 *    ignored it, so the pending host-perm promise never settled and
 *    the SDK hung waiting for cleanup.  The factory now resolves with
 *    a deny on abort and de-registers the pending entry.
 *
 * The helpers are in plain ESM (.mjs) so vitest can import them
 * directly without a transpile step.
 */
import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import {
  normalizeBridgeAllowDecision,
  createCanUseToolHandler,
} from "../../src-tauri/bridge/canUseToolHelpers.mjs";

describe("normalizeBridgeAllowDecision (REGRESSION: SDK ZodError on allow without updatedInput)", () => {
  const ORIG_INPUT = { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [] }] };

  it("echoes original input as updatedInput when host approves without edits", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "allow" }, ORIG_INPUT);
    expect(result).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("uses the host-supplied updatedInput when present (AskUserQuestion answers flow)", () => {
    const edited = { ...ORIG_INPUT, answers: { "Q?": "yes" } };
    const result = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: edited },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: edited });
  });

  it("falls back to original input when updatedInput is null", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: null },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("falls back to original input when updatedInput is a non-object (string/number)", () => {
    const r1 = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: "garbage" },
      ORIG_INPUT,
    );
    expect(r1).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });

    const r2 = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: 42 },
      ORIG_INPUT,
    );
    expect(r2).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("deny → behavior=deny + custom message (ExitPlanMode reject feedback flow)", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "deny", message: "rethink the migration" },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "deny", message: "rethink the migration" });
  });

  it("deny without message → defaults to 'user declined'", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "deny" }, ORIG_INPUT);
    expect(result).toEqual({ behavior: "deny", message: "user declined" });
  });

  it("deny with non-string message → safely defaults", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "deny", message: 12345 },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "deny", message: "user declined" });
  });

  it("invalid decision (null/string/wrong type) → deny with safe message", () => {
    expect(normalizeBridgeAllowDecision(null, ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
    expect(normalizeBridgeAllowDecision("garbage", ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
    expect(normalizeBridgeAllowDecision(undefined, ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
  });

  it("decision with unknown behavior → coerced to deny (defensive)", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "ask" }, ORIG_INPUT);
    expect(result.behavior).toBe("deny");
  });

  it("does NOT mutate the original input", () => {
    const input = { questions: [{ question: "Q?" }] };
    const before = JSON.stringify(input);
    normalizeBridgeAllowDecision({ behavior: "allow" }, input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ─── canUseTool factory ────────────────────────────────────────────

type PermPending = Map<string, { resolve: (decision: unknown) => void }>;

function makeHarness() {
  const writes: string[] = [];
  const stdout = { write: (chunk: string) => writes.push(chunk) };
  const permPending: PermPending = new Map();
  let nextId = 0;
  const idGen = () => `perm-${++nextId}`;
  const handler = createCanUseToolHandler({ stdout, permPending, idGen });
  return { writes, permPending, handler };
}

describe("createCanUseToolHandler — happy path", () => {
  it("writes a perm-request envelope to stdout with the right shape", async () => {
    const { writes, permPending, handler } = makeHarness();
    const promise = handler("Bash", { command: "ls" });
    // Resolve the host side so the awaited promise doesn't dangle.
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    await promise;

    expect(writes).toHaveLength(1);
    const envelope = JSON.parse(writes[0].trimEnd());
    expect(envelope).toEqual({
      type: "_hermes_perm_request",
      id: "perm-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
  });

  it("returns the normalized decision when the host responds", async () => {
    const { permPending, handler } = makeHarness();
    const promise = handler("Bash", { command: "ls" });
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    const result = await promise;
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("removes the pending entry after the host responds", async () => {
    const { permPending, handler } = makeHarness();
    const promise = handler("Bash", { command: "ls" });
    expect(permPending.has("perm-1")).toBe(true);
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    await promise;
    expect(permPending.has("perm-1")).toBe(false);
  });

  it("supports multiple concurrent in-flight prompts without cross-talk", async () => {
    const { permPending, handler } = makeHarness();
    const a = handler("Bash", { command: "a" });
    const b = handler("Bash", { command: "b" });

    expect(permPending.has("perm-1")).toBe(true);
    expect(permPending.has("perm-2")).toBe(true);

    permPending.get("perm-2")!.resolve({ behavior: "deny", message: "no" });
    permPending.get("perm-1")!.resolve({ behavior: "allow" });

    expect(await a).toEqual({ behavior: "allow", updatedInput: { command: "a" } });
    expect(await b).toEqual({ behavior: "deny", message: "no" });
  });
});

describe("createCanUseToolHandler — abort signal (REGRESSION: SDK abort hang)", () => {
  it("denies immediately when the signal is already aborted, never writes to stdout", async () => {
    const { writes, handler } = makeHarness();
    const ac = new AbortController();
    ac.abort();
    const result = await handler("Bash", { command: "rm" }, { signal: ac.signal });
    expect(result.behavior).toBe("deny");
    expect(writes).toHaveLength(0);
  });

  it("denies and cleans up when the signal aborts after the request is in flight", async () => {
    const { permPending, handler } = makeHarness();
    const ac = new AbortController();
    const promise = handler("Bash", { command: "rm" }, { signal: ac.signal });
    expect(permPending.has("perm-1")).toBe(true);
    ac.abort();
    const result = await promise;
    expect(result.behavior).toBe("deny");
    expect(permPending.has("perm-1")).toBe(false);
  });

  it("ignores a late host response after abort (no double-resolve, no stale state)", async () => {
    const { permPending, handler } = makeHarness();
    const ac = new AbortController();
    const promise = handler("Bash", { command: "rm" }, { signal: ac.signal });
    const pendingEntry = permPending.get("perm-1")!;

    ac.abort();
    const aborted = await promise;
    expect(aborted.behavior).toBe("deny");

    // Host sends a stale response after abort — must not reopen the
    // promise or repopulate `permPending`.
    expect(() => pendingEntry.resolve({ behavior: "allow" })).not.toThrow();
    expect(permPending.has("perm-1")).toBe(false);
  });

  it("ignores an abort fired after the host already responded", async () => {
    const { permPending, handler } = makeHarness();
    const ac = new AbortController();
    const promise = handler("Bash", { command: "ls" }, { signal: ac.signal });

    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    const result = await promise;
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });

    // Abort firing after success must not corrupt anything.
    expect(() => ac.abort()).not.toThrow();
    expect(permPending.has("perm-1")).toBe(false);
  });

  it("works without any abort signal (legacy 2-arg invocation)", async () => {
    const { permPending, handler } = makeHarness();
    const promise = handler("Bash", { command: "ls" });
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    expect(await promise).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("attaches the abort listener with `once: true` so it does not leak", async () => {
    const { permPending, handler } = makeHarness();
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const promise = handler("Bash", { command: "ls" }, { signal: ac.signal });
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    await promise;
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
  });
});
