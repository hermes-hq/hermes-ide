// ─── Notices from the Hermes team: the rules, as pure functions ───────
//
// One quiet card at the bottom of the sessions sidebar, never a pop-up, an
// OS notification or an inbox item. Two kinds share it:
//
//   remote  a notice from hermes-ide.com/notices.json, validated by the
//           backend (src-tauri/src/notices.rs). × marks it read for good.
//   star    the star ask, earned: at least 5 landed tasks on at least 3
//           different days, never in the first 7 days after first launch.
//           "Star on GitHub" and × end it for good. "Later" snoozes it 30
//           days, once: on the second showing Later is not offered, only
//           Star and × (simpler than a Later that silently means never).
//
// Polite timing, for both: a card shows only while no agent is waiting on
// the person and no dialog is open, one card at a time, and at most one NEW
// card every 7 days. A card already showing keeps its place (it is not new
// when it comes back after a dialog closes). Remote notices go before the
// star ask. The Settings switch "Show notices from the Hermes team" hides
// every card (and the backend stops fetching).
//
// Everything here is a function of the stored state, the time and what is
// on screen, so it is table-tested without React or Tauri.

export const STAR_ID = "star";
export const STAR_URL = "https://github.com/hermes-hq/hermes-ide";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const GRACE_MS = 7 * DAY_MS;
export const NEW_CARD_GAP_MS = 7 * DAY_MS;
export const SNOOZE_MS = 30 * DAY_MS;
export const MIN_LANDED = 5;
export const MIN_DAYS = 3;

/** The `notices_state` setting. */
export interface NoticesState {
  /** When this install first ran the notices (epoch ms). */
  firstSeen?: number;
  /** When the last new card first showed (epoch ms). */
  lastNewAt?: number;
  /** The card showing now (shown and not yet answered): "star" or a remote id. */
  current?: string;
  /** Remote notices closed for good. */
  read: string[];
  star: { shows: number; snoozedUntil?: number; done?: boolean };
}

/** The `notices_landed` setting (counted by the backend when a land succeeds). */
export interface Landed {
  count: number;
  days: string[];
}

export interface RemoteNotice {
  id: string;
  title: string;
  body: string;
  link: { label: string; url: string } | null;
  /** A still image the backend fetched and checked, as a data: URL with its alt text. */
  image?: { src: string; alt: string } | null;
}

export type NoticeCard =
  | { kind: "star"; landed: number; offerLater: boolean }
  | { kind: "remote"; notice: RemoteNotice };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Read `notices_state`; anything damaged reads as a fresh state. */
export function parseState(raw: string | undefined | null): NoticesState {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
  } catch {
    /* a fresh state */
  }
  const star = (v.star && typeof v.star === "object" ? v.star : {}) as Record<string, unknown>;
  return {
    firstSeen: num(v.firstSeen),
    lastNewAt: num(v.lastNewAt),
    current: typeof v.current === "string" ? v.current : undefined,
    read: Array.isArray(v.read) ? v.read.filter((x): x is string => typeof x === "string") : [],
    star: {
      shows: num(star.shows) ?? 0,
      snoozedUntil: num(star.snoozedUntil),
      done: star.done === true ? true : undefined,
    },
  };
}

/** Read `notices_landed`; anything damaged reads as nothing landed. */
export function parseLanded(raw: string | undefined | null): Landed {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return {
        count: num(o.count) ?? 0,
        days: Array.isArray(o.days) ? o.days.filter((d): d is string => typeof d === "string") : [],
      };
    }
  } catch {
    /* nothing landed */
  }
  return { count: 0, days: [] };
}

/**
 * The same allow-list the backend applies (it drops the notice before it
 * gets here); checked again before a link is opened.
 */
export function isAllowedNoticeLink(url: string): boolean {
  if (!url.startsWith("https://hermes-ide.com/") && !url.startsWith("https://github.com/hermes-hq/")) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  if (u.hostname === "hermes-ide.com") return true;
  return u.hostname === "github.com" && u.pathname.startsWith("/hermes-hq/");
}

/** Whether a remote image may be drawn: a data: URL of a PNG, WebP or JPEG (the webview never loads a remote address), with alt text. */
export function isDrawableImage(image: RemoteNotice["image"]): image is { src: string; alt: string } {
  return !!image && image.alt.trim() !== "" && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image.src);
}

/** Whether the star ask has been earned and may start now. */
export function starEligible(state: NoticesState, landed: Landed, now: number): boolean {
  const s = state.star;
  if (s.done || s.shows >= 2) return false;
  if (s.snoozedUntil !== undefined && now < s.snoozedUntil) return false;
  if (state.firstSeen === undefined || now - state.firstSeen < GRACE_MS) return false;
  return landed.count >= MIN_LANDED && new Set(landed.days).size >= MIN_DAYS;
}

export interface PickInput {
  state: NoticesState;
  landed: Landed;
  remote: readonly RemoteNotice[];
  now: number;
  enabled: boolean;
  /** An agent is waiting on the person (an approval, a question, a plan). */
  agentWaiting: boolean;
  /** A dialog or overlay is open. */
  dialogOpen: boolean;
}

export interface Pick {
  card: NoticeCard | null;
  /** The card starts now: record it (see `markShown`). */
  isNew: boolean;
}

function starCard(state: NoticesState, landed: Landed): NoticeCard {
  // Later is offered on the first showing only (see the header).
  return { kind: "star", landed: landed.count, offerLater: state.star.shows <= 1 };
}

/** The card to show now, if any. */
export function pickCard(input: PickInput): Pick {
  const { state, landed, remote, now } = input;
  const none: Pick = { card: null, isNew: false };
  if (!input.enabled || input.agentWaiting || input.dialogOpen) return none;
  const unread = remote.filter((n) => !state.read.includes(n.id) && (!n.link || isAllowedNoticeLink(n.link.url)));

  // The card already showing comes back as it was.
  if (state.current === STAR_ID && !state.star.done) return { card: starCard(state, landed), isNew: false };
  const showing = unread.find((n) => n.id === state.current);
  if (showing) return { card: { kind: "remote", notice: showing }, isNew: false };

  // A new card: at most one a week, remote notices first.
  if (state.lastNewAt !== undefined && now >= state.lastNewAt && now - state.lastNewAt < NEW_CARD_GAP_MS) return none;
  if (unread.length > 0) return { card: { kind: "remote", notice: unread[0] }, isNew: true };
  if (starEligible(state, landed, now)) return { card: starCard({ ...state, star: { ...state.star, shows: state.star.shows + 1 } }, landed), isNew: true };
  return none;
}

export function cardId(card: NoticeCard): string {
  return card.kind === "star" ? STAR_ID : card.notice.id;
}

/** A new card started showing. */
export function markShown(state: NoticesState, card: NoticeCard, now: number): NoticesState {
  const id = cardId(card);
  return {
    ...state,
    current: id,
    lastNewAt: now,
    star: id === STAR_ID ? { ...state.star, shows: state.star.shows + 1 } : state.star,
  };
}

/** Star on GitHub, or ×: the star ask never shows again. */
export function starDone(state: NoticesState): NoticesState {
  return { ...state, current: state.current === STAR_ID ? undefined : state.current, star: { ...state.star, done: true } };
}

/** Later: back in 30 days, once. */
export function starLater(state: NoticesState, now: number): NoticesState {
  return { ...state, current: state.current === STAR_ID ? undefined : state.current, star: { ...state.star, snoozedUntil: now + SNOOZE_MS } };
}

/** × on a remote notice (or its link followed): read for good. */
export function markRead(state: NoticesState, id: string): NoticesState {
  return {
    ...state,
    current: state.current === id ? undefined : state.current,
    read: state.read.includes(id) ? state.read : [...state.read, id],
  };
}

/** The first run of the notices on this install starts the 7-day grace. */
export function withFirstSeen(state: NoticesState, now: number): NoticesState {
  return state.firstSeen === undefined ? { ...state, firstSeen: now } : state;
}
