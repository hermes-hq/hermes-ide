/**
 * Bridge `buildPermissionOptions` regression coverage.
 *
 * The SDK requires `allowDangerouslySkipPermissions: true` alongside
 * `permissionMode: "bypassPermissions"` (sdk.d.ts:1490 and 3286). Setting
 * only the mode without the boolean leaves the SDK in a state where it
 * refuses to bypass — surfacing as "permission denied" errors the host
 * UI cannot explain.
 *
 * Hermes' UI exposes the permission-mode chip as flippable to ANY mode
 * mid-session. The SDK's runtime `setPermissionMode` control op refuses
 * to enter `bypassPermissions` unless the session was spawned with
 * `allowDangerouslySkipPermissions: true`. We therefore grant the
 * capability up-front for every spawn — regardless of the initial mode —
 * so that mid-session flips into Bypass don't fail with a confusing
 * "session was not launched with --dangerously-skip-permissions" error.
 *
 * Granting the capability does NOT itself bypass anything; the SDK still
 * requires `permissionMode: "bypassPermissions"` to actually skip prompts.
 *
 * If this test fails, either the bridge has stopped granting the capability
 * (mid-session Bypass flip will fail) or it stopped passing through the
 * caller's `permissionMode`.
 */
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import { buildPermissionOptions } from "../../src-tauri/bridge/canUseToolHelpers.mjs";

describe("buildPermissionOptions", () => {
  it("bypassPermissions sets BOTH the mode and allowDangerouslySkipPermissions=true (SDK contract)", () => {
    const result = buildPermissionOptions({ permissionMode: "bypassPermissions" });
    expect(result).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it.each(["default", "acceptEdits", "plan", "dontAsk", "auto"] as const)(
    "%s mode ALSO grants allowDangerouslySkipPermissions=true so mid-session flip into Bypass works",
    (mode) => {
      const result = buildPermissionOptions({ permissionMode: mode });
      expect(result).toEqual({
        permissionMode: mode,
        allowDangerouslySkipPermissions: true,
      });
    },
  );

  it("no permissionMode → still grants the bypass capability for runtime flips", () => {
    // The SDK uses its own default mode; we still want the capability set
    // so a later setPermissionMode("bypassPermissions") control op succeeds.
    expect(buildPermissionOptions({})).toEqual({ allowDangerouslySkipPermissions: true });
    expect(buildPermissionOptions({ permissionMode: undefined })).toEqual({
      allowDangerouslySkipPermissions: true,
    });
  });

  it("ignores non-string permissionMode values defensively but still grants the capability", () => {
    // @ts-expect-error — testing runtime tolerance to malformed flags
    expect(buildPermissionOptions({ permissionMode: 42 })).toEqual({
      allowDangerouslySkipPermissions: true,
    });
    // @ts-expect-error
    expect(buildPermissionOptions({ permissionMode: null })).toEqual({
      allowDangerouslySkipPermissions: true,
    });
  });

  it("tolerates a null/undefined flags object and still grants the capability", () => {
    // @ts-expect-error — defensive guard for early-init callers
    expect(buildPermissionOptions(null)).toEqual({ allowDangerouslySkipPermissions: true });
    expect(
      buildPermissionOptions(undefined as unknown as { permissionMode?: string }),
    ).toEqual({ allowDangerouslySkipPermissions: true });
  });
});
