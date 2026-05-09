/**
 * Bridge `buildPermissionOptions` regression coverage.
 *
 * The SDK requires `allowDangerouslySkipPermissions: true` to be set
 * alongside `permissionMode: "bypassPermissions"` (sdk.d.ts:1490 and
 * 3286).  Setting only the mode without the boolean leaves the SDK in
 * a state where it may refuse to bypass — surfacing as "permission
 * denied" errors that the host UI cannot explain.
 *
 * If this test fails, agents launched in bypassPermissions mode (e.g.
 * automated tasks, fully-trusted agent contexts) will mysteriously
 * still prompt for permission.
 */
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import { buildPermissionOptions } from "../../src-tauri/bridge/canUseToolHelpers.mjs";

describe("buildPermissionOptions", () => {
  it("bypassPermissions ALSO sets allowDangerouslySkipPermissions=true (SDK contract)", () => {
    const result = buildPermissionOptions({ permissionMode: "bypassPermissions" });
    expect(result).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it.each(["default", "acceptEdits", "plan", "dontAsk", "auto"] as const)(
    "%s mode does NOT set allowDangerouslySkipPermissions",
    (mode) => {
      const result = buildPermissionOptions({ permissionMode: mode });
      expect(result).toEqual({ permissionMode: mode });
      expect(result).not.toHaveProperty("allowDangerouslySkipPermissions");
    },
  );

  it("no permissionMode → empty object (SDK uses its own default)", () => {
    expect(buildPermissionOptions({})).toEqual({});
    expect(buildPermissionOptions({ permissionMode: undefined })).toEqual({});
  });

  it("ignores non-string permissionMode values defensively", () => {
    // @ts-expect-error — testing runtime tolerance to malformed flags
    expect(buildPermissionOptions({ permissionMode: 42 })).toEqual({});
    // @ts-expect-error
    expect(buildPermissionOptions({ permissionMode: null })).toEqual({});
  });

  it("tolerates a null/undefined flags object", () => {
    // @ts-expect-error — defensive guard for early-init callers
    expect(buildPermissionOptions(null)).toEqual({});
    expect(buildPermissionOptions(undefined as unknown as { permissionMode?: string })).toEqual({});
  });
});
