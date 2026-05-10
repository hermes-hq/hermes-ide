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
  ruleMatches,
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

// ─── ruleMatches — pattern matcher for the in-memory allowlist ─────

describe("ruleMatches", () => {
  it("returns false on empty / non-string input", () => {
    expect(ruleMatches("", "Bash", { command: "ls" })).toBe(false);
    expect(ruleMatches(undefined, "Bash", { command: "ls" })).toBe(false);
    expect(ruleMatches(null, "Bash", { command: "ls" })).toBe(false);
  });

  it("returns false when the tool name doesn't match", () => {
    expect(ruleMatches("Bash(ls:*)", "Read", { command: "ls" })).toBe(false);
  });

  it("a tool-only rule matches any invocation of unscoped tools", () => {
    // SomeTool not in the scope-required set → bare rule grants any input.
    expect(ruleMatches("WebFetch", "WebFetch", { url: "https://x" })).toBe(true);
    // Bare rule for the destructive trio is REFUSED — defense-in-depth.
    // The host UI never emits these (it always scopes), but a malformed
    // disk-loaded rule must never silently widen the grant surface.
    expect(ruleMatches("Bash", "Bash", { command: "anything" })).toBe(false);
    expect(ruleMatches("Read", "Read", { file_path: "/etc/hosts" })).toBe(false);
    expect(ruleMatches("Edit", "Edit", { file_path: "/etc/hosts" })).toBe(false);
    expect(ruleMatches("Write", "Write", { file_path: "/etc/hosts" })).toBe(false);
    expect(ruleMatches("Bash", "Read", { file_path: "x" })).toBe(false);
  });

  it("Bash rules with `<command>:*` prefix-match the command on word boundary", () => {
    expect(ruleMatches("Bash(git status:*)", "Bash", { command: "git status" })).toBe(true);
    expect(ruleMatches("Bash(git status:*)", "Bash", { command: "git status --short" })).toBe(true);
    expect(ruleMatches("Bash(git status:*)", "Bash", { command: "git diff" })).toBe(false);
    // Word-boundary regression: "ls" must NOT match "lsof".
    expect(ruleMatches("Bash(ls:*)", "Bash", { command: "ls" })).toBe(true);
    expect(ruleMatches("Bash(ls:*)", "Bash", { command: "ls -la" })).toBe(true);
    expect(ruleMatches("Bash(ls:*)", "Bash", { command: "lsof -i" })).toBe(false);
  });

  it("Bash rules WITHOUT `:*` require exact command match", () => {
    expect(ruleMatches("Bash(git status)", "Bash", { command: "git status" })).toBe(true);
    expect(ruleMatches("Bash(git status)", "Bash", { command: "git status --short" })).toBe(false);
  });

  it("rejects an empty-prefix wildcard (would otherwise allow ANY bash command)", () => {
    expect(ruleMatches("Bash(:*)", "Bash", { command: "rm -rf /" })).toBe(false);
  });

  it("Read/Edit/Write rules require an exact file_path match", () => {
    expect(ruleMatches("Read(/etc/hosts)", "Read", { file_path: "/etc/hosts" })).toBe(true);
    expect(ruleMatches("Read(/etc/hosts)", "Read", { file_path: "/etc/hosts.bak" })).toBe(false);
    expect(ruleMatches("Edit(/a.ts)", "Edit", { file_path: "/a.ts" })).toBe(true);
    expect(ruleMatches("Write(/a.ts)", "Write", { file_path: "/a.ts" })).toBe(true);
  });

  it("rules with mismatched tool kind are not granted (Bash rule on Read tool)", () => {
    expect(ruleMatches("Bash(ls:*)", "Read", { command: "ls" })).toBe(false);
  });

  it("malformed rules fail closed (do not silently grant)", () => {
    expect(ruleMatches("(no-tool)", "Bash", { command: "ls" })).toBe(false);
    expect(ruleMatches("Bash(", "Bash", { command: "ls" })).toBe(false);
  });
});

// ─── createCanUseToolHandler — bypass + allowlist short-circuits ───

describe("createCanUseToolHandler — bypassPermissions", () => {
  it("auto-allows without writing to stdout or registering pending", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => "should-not-be-called",
      permissionMode: "bypassPermissions",
    });
    const result = await handler("Bash", { command: "rm -rf /" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf /" } });
    expect(writes).toHaveLength(0);
    expect(permPending.size).toBe(0);
  });

  it("default mode still round-trips through the host", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    let nextId = 0;
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => `perm-${++nextId}`,
      permissionMode: "default",
    });
    const promise = handler("Bash", { command: "ls" });
    expect(writes).toHaveLength(1);
    permPending.get("perm-1")!.resolve({ behavior: "allow" });
    await promise;
  });
});

describe("createCanUseToolHandler — session allowlist", () => {
  function makeAllowListHarness(initialRules: string[] = []) {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    let nextId = 0;
    const sessionAllowList = new Set<string>(initialRules);
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => `perm-${++nextId}`,
      sessionAllowList,
    });
    return { writes, permPending, handler, sessionAllowList };
  }

  it("auto-allows when an existing rule matches — no host round-trip", async () => {
    const { writes, handler, permPending } = makeAllowListHarness(["Bash(git status:*)"]);
    const result = await handler("Bash", { command: "git status --short" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "git status --short" } });
    expect(writes).toHaveLength(0);
    expect(permPending.size).toBe(0);
  });

  it("forwards to host when no rule matches", async () => {
    const { writes, permPending, handler } = makeAllowListHarness(["Bash(git status:*)"]);
    const promise = handler("Bash", { command: "rm -rf /" });
    expect(writes).toHaveLength(1);
    permPending.get("perm-1")!.resolve({ behavior: "deny", message: "no" });
    const result = await promise;
    expect(result.behavior).toBe("deny");
  });

  it("caches the host's persist rule for subsequent matching calls", async () => {
    const { writes, permPending, handler, sessionAllowList } = makeAllowListHarness();
    // First call: host approves with a persist rule.
    const p1 = handler("Bash", { command: "ls -la" });
    permPending.get("perm-1")!.resolve({
      behavior: "allow",
      persist: "Bash(ls:*)",
    });
    await p1;
    expect(sessionAllowList.has("Bash(ls:*)")).toBe(true);
    // Second call: matches the cached rule → no new request to host.
    const writesBefore = writes.length;
    const p2 = handler("Bash", { command: "ls /tmp" });
    expect(writes.length).toBe(writesBefore); // no new envelope
    expect(await p2).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls /tmp" },
    });
  });

  it("does not cache rules from deny decisions", async () => {
    const { permPending, handler, sessionAllowList } = makeAllowListHarness();
    const p1 = handler("Bash", { command: "rm -rf /" });
    // A "persist" alongside a deny should be ignored — denies don't grant access.
    permPending.get("perm-1")!.resolve({
      behavior: "deny",
      message: "no",
      persist: "Bash(rm:*)",
    });
    await p1;
    expect(sessionAllowList.size).toBe(0);
  });

  it("ignores non-string persist values", async () => {
    const { permPending, handler, sessionAllowList } = makeAllowListHarness();
    const p1 = handler("Bash", { command: "ls" });
    permPending.get("perm-1")!.resolve({
      behavior: "allow",
      persist: 42,
    });
    await p1;
    expect(sessionAllowList.size).toBe(0);
  });

  it("bypass takes precedence over allowlist (still no round-trip)", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    const sessionAllowList = new Set<string>();
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => "x",
      permissionMode: "bypassPermissions",
      sessionAllowList,
    });
    const result = await handler("Bash", { command: "anything" });
    expect(result.behavior).toBe("allow");
    expect(writes).toHaveLength(0);
    // Bypass shouldn't pollute the allowlist.
    expect(sessionAllowList.size).toBe(0);
  });
});

describe("createCanUseToolHandler — live mode getter (regression)", () => {
  it("honors a mid-session flip from default to bypassPermissions", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    let liveMode: string = "default";
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => "should-not-fire",
      getPermissionMode: () => liveMode,
    });

    liveMode = "bypassPermissions";
    const result = await handler("Bash", { command: "rm -rf /" });

    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf /" } });
    expect(writes).toHaveLength(0);
    expect(permPending.size).toBe(0);
  });

  it("honors a mid-session flip from bypassPermissions back to default (round-trips again)", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    let liveMode: string = "bypassPermissions";
    let nextId = 0;
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => `perm-${++nextId}`,
      getPermissionMode: () => liveMode,
    });

    await handler("Bash", { command: "ls" });
    expect(writes).toHaveLength(0);

    liveMode = "default";
    const promise = handler("Bash", { command: "rm -rf /" });
    expect(writes).toHaveLength(1);
    permPending.get("perm-1")!.resolve({ behavior: "deny", message: "no" });
    const r = await promise;
    expect(r.behavior).toBe("deny");
  });

  it("getter takes precedence over the static permissionMode value", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const handler = createCanUseToolHandler({
      stdout,
      permPending: new Map(),
      idGen: () => "x",
      permissionMode: "default",
      getPermissionMode: () => "bypassPermissions",
    });
    const r = await handler("Bash", { command: "ls" });
    expect((r as { behavior: string }).behavior).toBe("allow");
    expect(writes).toHaveLength(0);
  });
});

// ─── Memory-safety hardening — caps + overwrite guard ──────────────

describe("createCanUseToolHandler — permPending overflow protection", () => {
  it("rejects when permPending hits the cap and emits a deny for the oldest evicted entry", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    let nextId = 0;
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => `perm-${++nextId}`,
      permPendingMaxSize: 3,
    });
    // Fill the cap with three never-resolved entries (host has gone away).
    const p1 = handler("Bash", { command: "first" });
    const p2 = handler("Bash", { command: "second" });
    const p3 = handler("Bash", { command: "third" });
    expect(permPending.size).toBe(3);
    // Fourth call evicts the oldest (perm-1) by settling it with deny;
    // the new request takes that slot.
    const p4 = handler("Bash", { command: "fourth" });
    // The first promise resolves with the synthetic eviction deny.
    const r1 = await p1;
    expect(r1.behavior).toBe("deny");
    // perm-2, perm-3 still pending; perm-4 is queued.
    expect(permPending.size).toBe(3);
    // Resolve the rest so the test doesn't dangle.
    permPending.get("perm-2")!.resolve({ behavior: "allow" });
    permPending.get("perm-3")!.resolve({ behavior: "allow" });
    permPending.get("perm-4")!.resolve({ behavior: "allow" });
    await Promise.all([p2, p3, p4]);
  });

  it("refuses a duplicate id rather than silently overwriting", async () => {
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };
    const permPending: PermPending = new Map();
    // idGen always returns the same id — simulates a bug in id generation.
    const handler = createCanUseToolHandler({
      stdout,
      permPending,
      idGen: () => "static-id",
    });
    const p1 = handler("Bash", { command: "first" });
    // Second concurrent call uses the same id; should be denied
    // synchronously rather than overwriting the entry for p1.
    const r2 = await handler("Bash", { command: "second" });
    expect(r2.behavior).toBe("deny");
    expect((r2 as { message?: string }).message).toMatch(/collision/);
    // p1's entry must still be intact.
    expect(permPending.has("static-id")).toBe(true);
    permPending.get("static-id")!.resolve({ behavior: "allow" });
    await p1;
  });
});
