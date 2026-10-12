import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  STAR_ID,
  isAllowedNoticeLink,
  isDrawableImage,
  markRead,
  markShown,
  parseLanded,
  parseState,
  pickCard,
  starDone,
  starEligible,
  starLater,
  withFirstSeen,
  type Landed,
  type NoticesState,
  type PickInput,
  type RemoteNotice,
} from "../notices/model";
import { noticesEnabledFrom } from "../notices/store";

const T0 = Date.UTC(2026, 9, 1);
const fresh = (): NoticesState => ({ read: [], star: { shows: 0 } });
const earned: Landed = { count: 5, days: ["2026-10-01", "2026-10-03", "2026-10-05"] };
const notice = (id: string, url?: string): RemoteNotice => ({
  id,
  title: `Title ${id}`,
  body: "Body",
  link: url ? { label: "Read more", url } : null,
});

function input(over: Partial<PickInput> = {}): PickInput {
  return {
    state: { ...fresh(), firstSeen: T0 },
    landed: earned,
    remote: [],
    now: T0 + 8 * DAY_MS,
    enabled: true,
    agentWaiting: false,
    dialogOpen: false,
    ...over,
  };
}

describe("the star ask is earned", () => {
  const state = { ...fresh(), firstSeen: T0 };
  const after = T0 + 8 * DAY_MS;

  it("needs 5 landed tasks on 3 different days, after the first 7 days", () => {
    expect(starEligible(state, earned, after)).toBe(true);
    expect(starEligible(state, { ...earned, count: 4 }, after)).toBe(false);
    expect(starEligible(state, { count: 9, days: ["2026-10-01", "2026-10-03", "2026-10-03"] }, after)).toBe(false);
    expect(starEligible(state, earned, T0 + 7 * DAY_MS - 1)).toBe(false);
    expect(starEligible(state, earned, T0 + 7 * DAY_MS)).toBe(true);
    expect(starEligible(fresh(), earned, after)).toBe(false);
  });

  it("never again after Star or ×, and not while snoozed", () => {
    expect(starEligible(starDone(state), earned, after)).toBe(false);
    const snoozed = starLater(state, after);
    expect(starEligible(snoozed, earned, after + 29 * DAY_MS)).toBe(false);
    expect(starEligible(snoozed, earned, after + 30 * DAY_MS)).toBe(true);
  });
});

describe("pickCard", () => {
  it("shows the star ask when it is earned, and not otherwise", () => {
    const pick = pickCard(input());
    expect(pick.card).toEqual({ kind: "star", landed: 5, offerLater: true });
    expect(pick.isNew).toBe(true);
    expect(pickCard(input({ landed: { count: 4, days: earned.days } })).card).toBeNull();
    expect(pickCard(input({ now: T0 + DAY_MS })).card).toBeNull();
  });

  it("stays quiet while an agent waits, a dialog is open or the switch is off", () => {
    expect(pickCard(input({ agentWaiting: true })).card).toBeNull();
    expect(pickCard(input({ dialogOpen: true })).card).toBeNull();
    expect(pickCard(input({ enabled: false })).card).toBeNull();
    // ...also a card already showing.
    const shown = markShown(input().state, pickCard(input()).card!, input().now);
    expect(pickCard(input({ state: shown, dialogOpen: true })).card).toBeNull();
    expect(pickCard(input({ state: shown })).card).toEqual({ kind: "star", landed: 5, offerLater: true });
    expect(pickCard(input({ state: shown })).isNew).toBe(false);
  });

  it("puts remote notices before the star ask, one at a time", () => {
    const pick = pickCard(input({ remote: [notice("a"), notice("b")] }));
    expect(pick.card).toEqual({ kind: "remote", notice: notice("a") });
    expect(pick.isNew).toBe(true);
  });

  it("starts at most one new card a week", () => {
    const now = input().now;
    const shown = markShown(input().state, { kind: "remote", notice: notice("a") }, now);
    const read = markRead(shown, "a");
    expect(read.current).toBeUndefined();
    // The star ask (and the next notice) wait out the week.
    expect(pickCard(input({ state: read, remote: [notice("a"), notice("b")], now: now + 6 * DAY_MS })).card).toBeNull();
    expect(pickCard(input({ state: read, now: now + 6 * DAY_MS })).card).toBeNull();
    expect(pickCard(input({ state: read, remote: [notice("a"), notice("b")], now: now + 7 * DAY_MS })).card).toEqual({ kind: "remote", notice: notice("b") });
    expect(pickCard(input({ state: read, now: now + 7 * DAY_MS })).card?.kind).toBe("star");
  });

  it("Later snoozes 30 days once; the second showing offers only Star and ×", () => {
    const now = input().now;
    let s = markShown(input().state, pickCard(input()).card!, now);
    expect(s.current).toBe(STAR_ID);
    s = starLater(s, now + DAY_MS);
    expect(s.current).toBeUndefined();
    expect(pickCard(input({ state: s, now: now + 20 * DAY_MS })).card).toBeNull();
    const second = pickCard(input({ state: s, now: now + 31 * DAY_MS }));
    expect(second.card).toEqual({ kind: "star", landed: 5, offerLater: false });
    s = markShown(s, second.card!, now + 31 * DAY_MS);
    expect(s.star.shows).toBe(2);
    expect(pickCard(input({ state: s, now: now + 32 * DAY_MS })).card).toEqual({ kind: "star", landed: 5, offerLater: false });
    // Answered: never again, however long.
    s = starDone(s);
    expect(pickCard(input({ state: s, now: now + 400 * DAY_MS })).card).toBeNull();
    // Even a third showing that slipped through a snooze is refused.
    expect(starEligible({ ...s, star: { shows: 2 } }, earned, now + 400 * DAY_MS)).toBe(false);
  });

  it("× on a remote notice marks it read for good", () => {
    const s = markRead(input().state, "a");
    expect(pickCard(input({ state: s, remote: [notice("a")], landed: { count: 0, days: [] } })).card).toBeNull();
  });

  it("drops a remote notice whose link leaves the allow-list", () => {
    const pick = pickCard(input({ remote: [notice("bad", "https://evil.example/"), notice("ok", "https://hermes-ide.com/changelog")] }));
    expect(pick.card).toEqual({ kind: "remote", notice: notice("ok", "https://hermes-ide.com/changelog") });
  });
});

describe("link allow-list", () => {
  it.each([
    ["https://hermes-ide.com/", true],
    ["https://hermes-ide.com/changelog#2.2.10", true],
    ["https://github.com/hermes-hq/hermes-ide", true],
    ["http://hermes-ide.com/", false],
    ["https://hermes-ide.com", false],
    ["https://hermes-ide.com.evil.example/", false],
    ["https://hermes-ide.com@example.com/", false],
    ["https://hermes-ide.com:8443/", false],
    ["https://github.com/hermes-hq-evil/x", false],
    ["https://github.com/someone/hermes-ide", false],
    ["https://github.com/hermes-hq/../evil/x", false],
    ["javascript:alert(1)", false],
  ])("%s -> %s", (url, ok) => {
    expect(isAllowedNoticeLink(url)).toBe(ok);
  });
});

describe("remote images", () => {
  it("draws only a data: URL of a PNG, WebP or JPEG with alt text", () => {
    expect(isDrawableImage({ src: "data:image/png;base64,iVBORw0KGgo=", alt: "A star" })).toBe(true);
    expect(isDrawableImage({ src: "data:image/webp;base64,UklGRg==", alt: "A star" })).toBe(true);
    expect(isDrawableImage({ src: "data:image/jpeg;base64,/9j/", alt: "A star" })).toBe(true);
    expect(isDrawableImage({ src: "data:image/png;base64,iVBORw0KGgo=", alt: "  " })).toBe(false);
    expect(isDrawableImage({ src: "https://hermes-ide.com/notices/a.png", alt: "A star" })).toBe(false);
    expect(isDrawableImage({ src: "data:image/svg+xml;base64,PHN2Zz4=", alt: "A star" })).toBe(false);
    expect(isDrawableImage({ src: "data:image/png;base64,AA==\"onerror=", alt: "A star" })).toBe(false);
    expect(isDrawableImage(null)).toBe(false);
    expect(isDrawableImage(undefined)).toBe(false);
  });
});

describe("stored values", () => {
  it("damaged state and counts read as fresh", () => {
    expect(parseState("{oops")).toEqual(fresh());
    expect(parseState(undefined)).toEqual(fresh());
    expect(parseState('{"read":"x","star":7,"firstSeen":"soon"}')).toEqual(fresh());
    expect(parseLanded("nope")).toEqual({ count: 0, days: [] });
    expect(parseLanded('{"count":6,"days":["2026-10-01",3]}')).toEqual({ count: 6, days: ["2026-10-01"] });
  });

  it("round-trips the state", () => {
    const s: NoticesState = { firstSeen: 1, lastNewAt: 2, current: STAR_ID, read: ["a"], star: { shows: 1, snoozedUntil: 3 } };
    expect(parseState(JSON.stringify(s))).toEqual({ ...s, star: { ...s.star, done: undefined } });
  });

  it("the first run starts the grace period once", () => {
    const s = withFirstSeen(fresh(), 10);
    expect(s.firstSeen).toBe(10);
    expect(withFirstSeen(s, 20)).toBe(s);
  });

  it("the switch is on unless off", () => {
    expect(noticesEnabledFrom(undefined)).toBe(true);
    expect(noticesEnabledFrom("on")).toBe(true);
    expect(noticesEnabledFrom("off")).toBe(false);
    expect(noticesEnabledFrom(" OFF ")).toBe(false);
  });
});
