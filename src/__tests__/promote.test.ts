/**
 * Beta → stable promotion rules (scripts/ci/promote.mjs).
 */
import { describe, it, expect, vi } from "vitest";
import { chooseCandidate, holdsFromIssues, checkLiveManifest, parseVersionTag, compareVersions } from "../../scripts/ci/promote.mjs";

const H = 3600 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

const rel = (tag_name: string, o: Partial<{ draft: boolean; prerelease: boolean; published_at: string }> = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  published_at: at(200),
  ...o,
});

describe("version tags", () => {
  it("accepts only plain vX.Y.Z", () => {
    expect(parseVersionTag("v1.4.1")).toEqual([1, 4, 1]);
    expect(parseVersionTag("v0.0.0-dryrun-3")).toBeNull();
    expect(parseVersionTag("staging")).toBeNull();
    expect(compareVersions([1, 4, 10], [1, 4, 9])).toBe(1);
    expect(compareVersions([1, 4, 1], [1, 4, 1])).toBe(0);
  });
});

describe("chooseCandidate", () => {
  const stable140 = rel("v1.4.0");

  it("promotes the prerelease once it has soaked", () => {
    const beta = rel("v1.4.1", { prerelease: true, published_at: at(25) });
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW })).toEqual({ tag: "v1.4.1", previous: "v1.4.0" });
  });

  it("waits while the prerelease is still soaking", () => {
    const beta = rel("v1.4.1", { prerelease: true, published_at: at(23) });
    const r = chooseCandidate({ releases: [beta, stable140], now: NOW });
    expect(r.tag).toBeNull();
    expect(r.why).toContain("v1.4.1 still soaking");
  });

  it("never promotes a draft, a dry-run tag or an older version", () => {
    const releases = [
      rel("v1.4.2", { prerelease: true, draft: true, published_at: at(48) }),
      rel("v0.0.0-dryrun-1", { prerelease: true, published_at: at(48) }),
      rel("v1.3.9", { prerelease: true, published_at: at(48) }),
      stable140,
    ];
    const r = chooseCandidate({ releases, now: NOW });
    expect(r.tag).toBeNull();
    expect(r.why).toContain("v1.3.9 is not newer than the current latest v1.4.0");
  });

  it("is stopped by a release-hold issue", () => {
    const beta = rel("v1.4.1", { prerelease: true, published_at: at(30) });
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, holds: holdsFromIssues([{ title: "Hold v1.4.1: crash on start" }]) })).toMatchObject({
      tag: null,
      why: expect.stringContaining("held"),
    });
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, holds: holdsFromIssues([{ title: "Freeze all releases" }]) }).tag).toBeNull();
    // A hold for another tag does not apply.
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, holds: holdsFromIssues([{ title: "Hold v1.4.2" }]) }).tag).toBe("v1.4.1");
  });

  it("picks the newest soaked prerelease when several wait", () => {
    const releases = [
      rel("v1.4.1", { prerelease: true, published_at: at(80) }),
      rel("v1.4.2", { prerelease: true, published_at: at(30) }),
      stable140,
    ];
    expect(chooseCandidate({ releases, now: NOW })).toEqual({ tag: "v1.4.2", previous: "v1.4.0" });
  });

  it("a manual pick skips the soak but not the hold", () => {
    const beta = rel("v1.4.1", { prerelease: true, published_at: at(1) });
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, forceTag: "v1.4.1" })).toEqual({ tag: "v1.4.1", previous: "v1.4.0" });
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, forceTag: "v1.4.1", holds: new Set(["*"]) }).tag).toBeNull();
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, forceTag: "v9.9.9" }).why).toContain("not a published");
    expect(chooseCandidate({ releases: [beta, stable140], now: NOW, forceTag: "v1.4.0" }).why).toContain("already stable");
  });

  it("works for the very first release", () => {
    const beta = rel("v1.0.0", { prerelease: true, published_at: at(30) });
    expect(chooseCandidate({ releases: [beta], now: NOW })).toEqual({ tag: "v1.0.0", previous: null });
  });
});

describe("checkLiveManifest", () => {
  const manifest = {
    version: "1.4.1",
    platforms: {
      "darwin-aarch64": { signature: "sig", url: "https://example.test/a.tar.gz" },
      "linux-x86_64-deb": { signature: "", url: "https://example.test/b.deb" },
    },
  };
  const response = (ok: boolean, body?: unknown, status = ok ? 200 : 404) =>
    ({ ok, status, json: async () => body, body: { cancel: async () => {} } }) as unknown as Response;

  it("is healthy when the manifest serves the version and every asset downloads", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("latest.json") ? response(true, { ...manifest, platforms: { "darwin-aarch64": manifest.platforms["darwin-aarch64"] } }) : response(true)));
    expect(await checkLiveManifest({ repo: "o/r", tag: "v1.4.1", fetchImpl, attempts: 1, delayMs: 0 })).toEqual([]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://github.com/o/r/releases/latest/download/latest.json");
  });

  it("reports a missing asset and an empty signature", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("latest.json") ? response(true, manifest) : response(!url.endsWith(".deb"))));
    expect(await checkLiveManifest({ repo: "o/r", tag: "v1.4.1", fetchImpl, attempts: 1, delayMs: 0 })).toEqual([
      "linux-x86_64-deb: empty signature",
      "linux-x86_64-deb: https://example.test/b.deb -> HTTP 404",
    ]);
  });

  it("retries while the CDN still serves the previous version, then gives up", async () => {
    const fetchImpl = vi.fn(async () => response(true, { ...manifest, version: "1.4.0" }));
    const problems = await checkLiveManifest({ repo: "o/r", tag: "v1.4.1", fetchImpl, attempts: 3, delayMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(problems).toEqual([expect.stringContaining("serves 1.4.0, expected 1.4.1")]);
  });
});
