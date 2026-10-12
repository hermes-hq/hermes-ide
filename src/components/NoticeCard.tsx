import "../styles/components/NoticeCard.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getSettings } from "../api/settings";
import { useInboxItems } from "../agent/contract/inbox";
import { topOverlay } from "../state/overlays";
import { useI18n } from "../i18n/I18nProvider";
import { Button, CloseButton } from "./ui/Button";
import starArt from "../assets/notices/star-notice.webp";
import {
  STAR_URL,
  cardId,
  isAllowedNoticeLink,
  isDrawableImage,
  markRead,
  markShown,
  parseLanded,
  parseState,
  pickCard,
  starDone,
  starLater,
  withFirstSeen,
  type Landed,
  type NoticesState,
  type RemoteNotice,
} from "../notices/model";
import { NOTICES_LANDED_KEY, NOTICES_STATE_KEY, listRemoteNotices, saveNoticesState, useNoticesEnabled } from "../notices/store";

// Notices from the Hermes team (src/notices/model.ts has the rules): one
// quiet card at the bottom of the sessions sidebar, above "New group".

/** How often the landed-task count is read again (the backend counts lands). */
const RELOAD_MS = 5 * 60 * 1000;
/** How often the remote list is asked for (the backend fetches at most once a day). */
const REMOTE_MS = 60 * 60 * 1000;
/** How often the card checks for an open dialog. */
const TICK_MS = 1500;
const THANKS_MS = 4000;

/** A dialog, sheet or overlay is open somewhere in the window. */
function dialogOpenNow(): boolean {
  if (topOverlay() !== null) return true;
  return document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]') !== null;
}

/** Opens a link in the browser. Test builds record it instead, so a test run never opens one. */
function openInBrowser(url: string): void {
  if (import.meta.env.VITE_HERMES_E2E === "1") {
    const w = window as unknown as { __HERMES_E2E_OPENED__?: string[] };
    (w.__HERMES_E2E_OPENED__ ??= []).push(url);
    return;
  }
  void shellOpen(url).catch(() => {});
}

function StarGlyph() {
  return (
    <svg className="notice-card-star-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** The image slot at the top of a card; a picture that fails to decode leaves no gap. */
function CardImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className="notice-card-image" src={src} alt={alt} draggable={false} onError={() => setFailed(true)} />;
}

export function NoticeCard() {
  const { t } = useI18n();
  const enabled = useNoticesEnabled();
  const inbox = useInboxItems();
  const agentWaiting = inbox.some((i) => i.kind === "blocked" && i.sessionId !== null);
  const [state, setState] = useState<NoticesState | null>(null);
  const [landed, setLanded] = useState<Landed>({ count: 0, days: [] });
  const [remote, setRemote] = useState<RemoteNotice[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [thanks, setThanks] = useState(false);
  const thanksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The stored state once, the landed count again every few minutes.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      getSettings()
        .then((s) => {
          if (!alive) return;
          setLanded(parseLanded(s[NOTICES_LANDED_KEY]));
          setState((prev) => {
            if (prev) return prev;
            const loaded = parseState(s[NOTICES_STATE_KEY]);
            const next = withFirstSeen(loaded, Date.now());
            if (next !== loaded) void saveNoticesState(next);
            return next;
          });
        })
        .catch(() => {});
    void load();
    const id = setInterval(load, RELOAD_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => listRemoteNotices().then((list) => alive && setRemote(list));
    void load();
    const id = setInterval(load, REMOTE_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      setDialogOpen(dialogOpenNow());
      setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  useEffect(() => () => {
    if (thanksTimer.current) clearTimeout(thanksTimer.current);
  }, []);

  const pick = useMemo(
    () => (state ? pickCard({ state, landed, remote, now, enabled, agentWaiting, dialogOpen }) : { card: null, isNew: false }),
    [state, landed, remote, now, enabled, agentWaiting, dialogOpen],
  );

  const update = useCallback((next: NoticesState) => {
    setState(next);
    void saveNoticesState(next);
  }, []);

  // A card starting now is recorded: it counts as this week's new card.
  useEffect(() => {
    if (state && pick.card && pick.isNew) update(markShown(state, pick.card, Date.now()));
  }, [state, pick, update]);

  if (thanks && enabled) {
    return (
      <div className="notice-card notice-card-thanks" role="status" data-notice="thanks">
        {t("notices.thanks")}
      </div>
    );
  }
  if (!state || !pick.card) return null;
  const card = pick.card;

  if (card.kind === "star") {
    const onStar = () => {
      openInBrowser(STAR_URL);
      update(starDone(state));
      setThanks(true);
      if (thanksTimer.current) clearTimeout(thanksTimer.current);
      thanksTimer.current = setTimeout(() => setThanks(false), THANKS_MS);
    };
    return (
      <aside className="notice-card" aria-label={t("notices.fromTeam")} data-notice={cardId(card)}>
        <CardImage src={starArt} alt={t("notices.starImageAlt")} />
        <div className="notice-card-header">
          <span className="notice-card-label">{t("notices.fromTeam")}</span>
          <CloseButton className="notice-card-close" label={t("notices.closeForGood")} onClick={() => update(starDone(state))} />
        </div>
        <p className="notice-card-title">{t("notices.starTitle", { count: card.landed })}</p>
        <p className="notice-card-body">{t("notices.starBody")}</p>
        <div className="notice-card-actions">
          <Button size="sm" className="notice-card-star" icon={<StarGlyph />} onClick={onStar}>
            {t("notices.starAction")}
          </Button>
          {card.offerLater && (
            <Button size="sm" variant="quiet" className="notice-card-later" onClick={() => update(starLater(state, Date.now()))}>
              {t("notices.later")}
            </Button>
          )}
        </div>
      </aside>
    );
  }

  const notice = card.notice;
  const link = notice.link && isAllowedNoticeLink(notice.link.url) ? notice.link : null;
  return (
    <aside className="notice-card" aria-label={t("notices.fromTeam")} data-notice={notice.id}>
      {isDrawableImage(notice.image) && <CardImage key={notice.id} src={notice.image.src} alt={notice.image.alt} />}
      <div className="notice-card-header">
        <span className="notice-card-label">{t("notices.fromTeam")}</span>
        <CloseButton className="notice-card-close" label={t("notices.close")} onClick={() => update(markRead(state, notice.id))} />
      </div>
      <p className="notice-card-title">{notice.title}</p>
      <p className="notice-card-body">{notice.body}</p>
      {link && (
        <div className="notice-card-actions">
          <Button
            size="sm"
            variant="link"
            className="notice-card-link"
            onClick={() => {
              openInBrowser(link.url);
              update(markRead(state, notice.id));
            }}
          >
            {link.label}
          </Button>
        </div>
      )}
    </aside>
  );
}
