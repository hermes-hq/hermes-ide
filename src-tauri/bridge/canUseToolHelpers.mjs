/**
 * Pure helpers for the bridge's `canUseTool` callback and SDK option
 * derivation.
 *
 * Extracted into a separate module so the host-decision normalization,
 * permission-option shaping, and the canUseTool factory all have unit
 * tests (the bridge entry point is not directly importable — it has
 * top-level argv parsing and an `await main()`).
 */

/**
 * Normalize a decision returned by the host into the exact shape the
 * SDK's canUseTool callback expects.
 *
 * Defensive echo of `updatedInput`: current SDK types mark the field
 * as optional on the allow shape, but a prior 0.x release rejected
 * omission with `ZodError("expected record, received undefined")` and
 * the tool call silently failed (the v1 plan-mode "Send does nothing"
 * regression).  Echoing the original input keeps us safe across SDK
 * versions and across hosts that approve without editing.  Cheap to
 * keep; expensive to rediscover.
 *
 * @param {unknown} decision           Raw value the host wrote on stdin.
 * @param {unknown} originalInput      The tool's original input (echoed
 *                                     when the host approves without edits).
 * @returns {{behavior: "allow", updatedInput: unknown} | {behavior: "deny", message: string}}
 */
export function normalizeBridgeAllowDecision(decision, originalInput) {
  if (!decision || typeof decision !== "object") {
    return { behavior: "deny", message: "host returned invalid decision" };
  }
  const d = /** @type {Record<string, unknown>} */ (decision);
  if (d.behavior === "allow") {
    const updatedInput =
      d.updatedInput && typeof d.updatedInput === "object"
        ? d.updatedInput
        : originalInput;
    return { behavior: "allow", updatedInput };
  }
  return {
    behavior: "deny",
    message: typeof d.message === "string" ? d.message : "user declined",
  };
}

/**
 * Tools that must NEVER be granted by a bare tool-name rule.  Matching a
 * bare `Bash` rule against any bash invocation would effectively give
 * Claude shell-execute for the rest of the session — which is not what
 * the user signed up for when they clicked "Allow always" on a specific
 * `git status` command.  We fail closed for this set: the rule must
 * include scope (a command prefix or an exact file path) or it doesn't
 * grant.  Defense-in-depth — the host UI already emits scoped rules for
 * these tools, but the matcher shouldn't trust that contract.
 *
 * @type {ReadonlySet<string>}
 */
const SCOPE_REQUIRED_TOOLS = new Set(["Bash", "Read", "Edit", "Write"]);

/**
 * Match a session allowlist rule against a (toolName, input) pair.
 *
 * Same syntax the host UI emits via `buildApproveAllAllowRule`:
 *   - `Bash(<command>:*)` — word-boundary prefix-match on the bash
 *     command string.  `:*` means "and any args after the command";
 *     `Bash(ls:*)` matches `ls` and `ls -la` but NOT `lsof`.
 *   - `Bash(<command>)` (no `:*`) — exact-match on the bash command.
 *   - `Read(<file_path>)` / `Edit(<file_path>)` / `Write(<file_path>)`
 *     — exact match on the input.file_path.
 *   - `<ToolName>` (no parens) — matches any invocation of that tool,
 *     EXCEPT for the scope-required tools above (Bash/Read/Edit/Write)
 *     which require an explicit scope.
 *
 * Anything that doesn't fit one of these shapes is treated as a no-match
 * rather than throwing — a mis-shaped rule should never silently grant
 * access to an unrelated tool.
 *
 * @param {string} rule
 * @param {string} toolName
 * @param {unknown} input
 * @returns {boolean}
 */
export function ruleMatches(rule, toolName, input) {
  if (typeof rule !== "string" || rule.length === 0) return false;
  const m = rule.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!m) return false;
  const [, ruleTool, ruleArgs] = m;
  if (ruleTool !== toolName) return false;
  if (ruleArgs === undefined) {
    // Bare tool-name rule — refuse to grant for the destructive set.
    return !SCOPE_REQUIRED_TOOLS.has(toolName);
  }
  const inp = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : null;
  if (toolName === "Bash") {
    if (!inp || typeof inp.command !== "string") return false;
    const wildcard = ruleArgs.endsWith(":*");
    const cmd = wildcard ? ruleArgs.slice(0, -2) : ruleArgs;
    if (cmd.length === 0) return false; // empty-prefix wildcard would match everything
    if (!wildcard) {
      // No wildcard → exact-match only.  Approval was for "this exact
      // command", not "anything starting with these letters".
      return inp.command === cmd;
    }
    // Wildcard prefix-match — but require a word boundary so the
    // prefix doesn't bleed into a different command (`ls` vs `lsof`).
    if (inp.command === cmd) return true;
    if (!inp.command.startsWith(cmd)) return false;
    const next = inp.command.charAt(cmd.length);
    return next === " " || next === "\t" || next === "\n";
  }
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    return Boolean(inp) && inp.file_path === ruleArgs;
  }
  return false;
}

/**
 * Build the `canUseTool` callback the SDK invokes when a tool is about
 * to run.  Two short-circuits before contacting the host:
 *
 *   1. **bypassPermissions mode** — the SDK is told not to enforce
 *      permissions; we mirror that here so the host modal never even
 *      flashes.  Without this short-circuit the modal would mount,
 *      auto-allow in a useEffect, and round-trip through stdin — any
 *      glitch in that round-trip would stall the agent.  Skipping the
 *      round-trip entirely matches user expectation ("bypass means
 *      bypass") and removes a class of races.
 *
 *   2. **session allowlist** — when the host previously approved a
 *      request with `persist: "<rule>"`, we cache the rule in memory
 *      for the lifetime of the bridge process and match subsequent
 *      requests against it.  This is what makes "Allow always" feel
 *      like it persists during a single session: prior to this, the
 *      rule was written to ~/.claude/settings.json by the host but the
 *      bridge never consulted that file, so the user got prompted
 *      again.  In-memory cache + persist field gives correct behaviour
 *      now; future work can also load disk rules at startup.
 *
 * Otherwise the bridge writes a `_hermes_perm_request` on stdout and
 * waits for `_hermes_perm_response` on stdin.  Honours the SDK's
 * abort signal — see the top-of-file comment.
 *
 * @template T
 * @param {object} deps
 * @param {{ write: (chunk: string) => unknown }} deps.stdout         Where to send the perm-request envelope.
 * @param {Map<string, { resolve: (decision: unknown) => void }>} deps.permPending  Pending-request registry; the stdin reader
 *                                                                                  resolves entries here when the host responds.
 * @param {() => string} deps.idGen                                                  Generates a unique request id per call.
 * @param {(decision: unknown, originalInput: unknown) => unknown} [deps.normalize]  Decision normalizer (defaults to {@link normalizeBridgeAllowDecision}).
 * @param {string} [deps.permissionMode]                                             SDK permissionMode flag.  When "bypassPermissions" the handler short-circuits to allow.
 * @param {() => string | undefined} [deps.getPermissionMode]                        Live getter — when present, takes precedence over `permissionMode`.  Use this so a mid-session `setPermissionMode` control op flips the bypass short-circuit immediately.
 * @param {Set<string>} [deps.sessionAllowList]                                      In-memory allowlist; mutated with persisted rules from host responses.
 * @returns {(toolName: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>}
 */
export function createCanUseToolHandler({
  stdout,
  permPending,
  idGen,
  normalize = normalizeBridgeAllowDecision,
  permissionMode,
  getPermissionMode,
  sessionAllowList,
  permPendingMaxSize = 1024,
}) {
  // Resolve "what is the current mode?" on every call, not on construction.
  // A static `permissionMode` value still works for back-compat (older tests
  // and any host that doesn't track live state).
  const readMode = typeof getPermissionMode === "function"
    ? getPermissionMode
    : () => permissionMode;
  return async function canUseTool(toolName, input, options) {
    const signal = options && options.signal;
    // Short-circuit when the signal is already aborted: don't even bother
    // bothering the host for a decision that will be discarded.
    if (signal && signal.aborted) {
      return normalize({ behavior: "deny", message: "aborted" }, input);
    }
    // 1. bypassPermissions — auto-allow without round-trip.
    if (readMode() === "bypassPermissions") {
      return normalize({ behavior: "allow" }, input);
    }
    // 2. Session allowlist — auto-allow when a prior decision matches.
    if (sessionAllowList && sessionAllowList.size > 0) {
      for (const rule of sessionAllowList) {
        if (ruleMatches(rule, toolName, input)) {
          return normalize({ behavior: "allow" }, input);
        }
      }
    }
    // Defensive cap on `permPending` — entries here represent a host
    // that hasn't responded yet.  In a healthy session the map churns
    // with at most a few in-flight entries.  If the host disappears
    // mid-prompt the entries can leak (each carries the original tool
    // input as a closure).  When we reach the cap, evict the OLDEST
    // entry (Map preserves insertion order) by settling it with a
    // synthetic deny so its closure becomes garbage-collectable.
    if (permPending.size >= permPendingMaxSize) {
      const oldestKey = permPending.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = permPending.get(oldestKey);
        permPending.delete(oldestKey);
        if (oldest && typeof oldest.resolve === "function") {
          oldest.resolve({ behavior: "deny", message: "evicted (host unresponsive)" });
        }
      }
    }
    const id = idGen();
    // Overwrite guard — `permPending.set(id, ...)` on a duplicate key
    // would silently lose the prior entry's resolver.  Practically
    // unreachable given idGen's monotonic counter + timestamp, but the
    // invariant "one entry per id" is worth enforcing in code rather
    // than trusting the gen.  Treat the dup as a deny so the SDK
    // doesn't hang.
    if (permPending.has(id)) {
      return normalize(
        { behavior: "deny", message: "perm request id collision" },
        input,
      );
    }
    const decision = await new Promise((resolve) => {
      // Single-shot resolver — first caller wins.  Prevents a double
      // resolve when the host's response and an abort race each other.
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        permPending.delete(id);
        resolve(value);
      };
      permPending.set(id, { resolve: settle });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => settle({ behavior: "deny", message: "aborted" }),
          { once: true },
        );
      }

      stdout.write(
        JSON.stringify({ type: "_hermes_perm_request", id, toolName, input }) + "\n",
      );
    });
    // Cache "approve always" rules so future calls in this session don't
    // re-prompt.  The host sends `persist: "<rule>"` alongside its allow
    // decision — we accept it only on a successful allow path.
    if (
      sessionAllowList &&
      decision &&
      typeof decision === "object" &&
      /** @type {Record<string, unknown>} */ (decision).behavior === "allow"
    ) {
      const persist = /** @type {Record<string, unknown>} */ (decision).persist;
      if (typeof persist === "string" && persist.length > 0) {
        sessionAllowList.add(persist);
      }
    }
    return normalize(decision, input);
  };
}

/**
 * Derive the permission-related slice of the SDK options from the
 * bridge's CLI flags.
 *
 * The SDK requires `allowDangerouslySkipPermissions: true` to be set
 * alongside `permissionMode: "bypassPermissions"` (see sdk.d.ts:1490).
 * Setting only the mode without the boolean leaves the SDK in a state
 * where it may refuse to actually bypass — surfacing as confusing
 * "permission denied" errors that the host UI cannot explain.
 *
 * @param {{ permissionMode?: string }} flags
 * @returns {{ permissionMode?: string, allowDangerouslySkipPermissions?: boolean }}
 */
export function buildPermissionOptions(flags) {
  const out = {};
  if (flags && typeof flags.permissionMode === "string") {
    out.permissionMode = flags.permissionMode;
    if (flags.permissionMode === "bypassPermissions") {
      out.allowDangerouslySkipPermissions = true;
    }
  }
  return out;
}
