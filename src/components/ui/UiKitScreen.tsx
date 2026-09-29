import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import "../../styles/ui/ui-kit-screen.css";
import { useI18n } from "../../i18n/I18nProvider";
import { THEME_OPTIONS, applyUiScale } from "../../utils/themeManager";
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  CloseButton,
  Counter,
  IconButton,
  Input,
  Menu,
  Radio,
  NativeSelect,
  RadioGroup,
  Segmented,
  Select,
  TabPanel,
  Tabs,
  Textarea,
  Toggle,
  type ButtonVariant,
  type SelectOption,
} from "./index";

/**
 * Hidden developer screen (Settings > Flags > Controls preview): every
 * control of src/components/ui in every state, in any theme, so the
 * real-app rig can screenshot it and measure it (e2e/app/scenarios/UI-kit.mjs).
 *
 * Hover, pressed and focus are shown by copying the stylesheet's own
 * :hover / :active / :focus-visible rules onto a data-preview attribute
 * (previewPseudoStates), so what is shown is exactly what those rules draw.
 */

type Preview = "hover" | "active" | "focus";
const PSEUDO: Record<Preview, string> = { hover: ":hover", active: ":active", focus: ":focus-visible" };

/** Copies every :hover / :active / :focus-visible rule onto [data-preview~=…]. Returns an undo. */
function previewPseudoStates(): () => void {
  const style = document.createElement("style");
  style.dataset.uiKitPreview = "";
  const out: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        let sel = rule.selectorText;
        let hit = false;
        for (const [state, pseudo] of Object.entries(PSEUDO)) {
          if (sel.includes(pseudo)) {
            sel = sel.split(pseudo).join(`[data-preview~="${state}"]`);
            hit = true;
          }
        }
        if (hit) out.push(`${sel} { ${rule.style.cssText} }`);
      } else if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule)) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A stylesheet from another origin cannot be read; none of ours is.
    }
  }
  style.textContent = out.join("\n");
  document.head.appendChild(style);
  return () => style.remove();
}

const AGENTS = (notInstalled: string): SelectOption[] => [
  { value: "claude-work", label: "Claude Code · Work", detail: "Max · 2.1.284" },
  { value: "claude-personal", label: "Claude Code · Personal", detail: "Pro" },
  { value: "codex", label: "Codex", detail: "0.145.0" },
  { value: "antigravity", label: "Antigravity", detail: notInstalled, disabled: true },
  { value: "goose", label: "goose", detail: "1.9.0" },
];

/** Program and model names: data, not interface text. */
const SHELLS = ["zsh", "bash", "fish"];
const MODELS = { opus: "opus", sonnet: "sonnet" };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="ui-kit-section" data-kit-section={id} aria-labelledby={`ui-kit-section-${id}`}>
      <h2 id={`ui-kit-section-${id}`} className="ui-kit-section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-kit-row">
      <span className="ui-kit-row-label">{label}</span>
      <div className="ui-kit-row-items">{children}</div>
    </div>
  );
}

const VARIANTS: Array<{ variant: ButtonVariant; key: string }> = [
  { variant: "primary", key: "uiKit.variant.primary" },
  { variant: "secondary", key: "uiKit.variant.secondary" },
  { variant: "quiet", key: "uiKit.variant.quiet" },
  { variant: "danger", key: "uiKit.variant.danger" },
  { variant: "danger-solid", key: "uiKit.variant.dangerSolid" },
  { variant: "link", key: "uiKit.variant.link" },
];

const REFRESH_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function UiKitScreen({ onClose, uiScale }: { onClose: () => void; uiScale?: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "frosted-dark");
  const [agent, setAgent] = useState<string | null>("claude-work");
  const [empty, setEmpty] = useState<string | null>(null);
  const [chipOn, setChipOn] = useState(true);
  const [chipOff, setChipOff] = useState(false);
  const [group, setGroup] = useState("turn");
  const [groupSm, setGroupSm] = useState("file");
  const [tab, setTab] = useState("review");
  const [nav, setNav] = useState("general");
  const [staged, setStaged] = useState(true);
  const [unstaged, setUnstaged] = useState(false);
  const [statusLine, setStatusLine] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [where, setWhere] = useState<"new" | "existing" | "folder">("new");
  const [lastAction, setLastAction] = useState<string | null>(null);

  // The screen may switch the theme for a look; put the user's back on close.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    return () => {
      if (before) root.dataset.theme = before;
      applyUiScale(uiScale ?? "default", before);
    };
  }, [uiScale]);

  useEffect(() => previewPseudoStates(), []);

  const pickTheme = (id: string) => {
    setTheme(id);
    document.documentElement.dataset.theme = id;
    applyUiScale(uiScale ?? "default", id);
  };

  const states: Array<{ key: string; preview?: Preview; disabled?: boolean; loading?: boolean }> = [
    { key: "uiKit.state.default" },
    { key: "uiKit.state.hover", preview: "hover" },
    { key: "uiKit.state.pressed", preview: "active" },
    { key: "uiKit.state.focus", preview: "focus" },
    { key: "uiKit.state.disabled", disabled: true },
    { key: "uiKit.state.loading", loading: true },
  ];

  return (
    <div className="ui-kit-screen" role="dialog" aria-modal="true" aria-labelledby="ui-kit-title" data-testid="ui-kit-screen">
      <header className="ui-kit-header">
        <div className="ui-kit-heading">
          <h1 id="ui-kit-title" className="ui-kit-title">
            {t("uiKit.title")}
          </h1>
          <p className="ui-kit-subtitle">{t("uiKit.subtitle")}</p>
        </div>
        <label className="ui-kit-theme">
          <span className="ui-kit-row-label">{t("uiKit.theme")}</span>
          <NativeSelect data-kit="theme" value={theme} onChange={(e) => pickTheme(e.target.value)}>
            {THEME_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <CloseButton label={t("uiKit.close")} onClick={onClose} data-kit="close" />
      </header>

      <div className="ui-kit-body">
        <Section id="buttons" title={t("uiKit.buttons")}>
          {VARIANTS.map(({ variant, key }) => (
            <Row key={variant} label={t(key)}>
              {states.map((s) => (
                <Button
                  key={s.key}
                  variant={variant}
                  disabled={s.disabled}
                  loading={s.loading}
                  data-preview={s.preview}
                  data-kit={`btn-${variant}-${s.preview ?? (s.disabled ? "disabled" : s.loading ? "loading" : "default")}`}
                >
                  {t(s.key)}
                </Button>
              ))}
            </Row>
          ))}
          <Row label={t("uiKit.sizes")}>
            <Button size="sm" data-kit="btn-sm">
              {t("uiKit.size.sm")}
            </Button>
            <Button size="md" data-kit="btn-md">
              {t("uiKit.size.md")}
            </Button>
            <Button size="lg" data-kit="btn-lg">
              {t("uiKit.size.lg")}
            </Button>
            <Button variant="primary" size="sm" icon={REFRESH_ICON}>
              {t("uiKit.size.sm")}
            </Button>
            <Button variant="primary" size="lg" icon={REFRESH_ICON}>
              {t("uiKit.size.lg")}
            </Button>
          </Row>
          <Row label={t("uiKit.iconButtons")}>
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} data-kit="icon-md" />
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} size="sm" data-kit="icon-sm" />
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} data-preview="hover" />
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} pressed />
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} data-preview="focus" />
            <IconButton label={t("uiKit.sample.refresh")} icon={REFRESH_ICON} disabled />
            <CloseButton label={t("uiKit.close")} data-kit="close-sample" />
          </Row>
        </Section>

        <Section id="fields" title={t("uiKit.fields")}>
          <Row label={t("uiKit.state.default")}>
            <Input aria-label={t("uiKit.sample.search")} placeholder={t("uiKit.sample.search")} data-kit="input-md" />
            <Input aria-label={t("uiKit.sample.search")} placeholder={t("uiKit.sample.search")} size="sm" data-kit="input-sm" />
            <Input aria-label={t("uiKit.sample.branch")} code defaultValue="hermes/fix-flaky-login" data-kit="input-code" />
          </Row>
          <Row label={t("uiKit.state.hover")}>
            <Input aria-label={t("uiKit.sample.search")} defaultValue={t("uiKit.sample.task")} data-preview="hover" />
          </Row>
          <Row label={t("uiKit.state.focus")}>
            <Input aria-label={t("uiKit.sample.search")} defaultValue={t("uiKit.sample.task")} data-preview="focus" data-kit="input-focus" />
          </Row>
          <Row label={t("uiKit.state.disabled")}>
            <Input aria-label={t("uiKit.sample.search")} defaultValue={t("uiKit.sample.task")} disabled />
          </Row>
          <Row label={t("uiKit.state.invalid")}>
            <Input aria-label={t("uiKit.sample.branch")} code defaultValue="main" error={t("uiKit.sample.branchTaken")} data-kit="input-invalid" />
          </Row>
          <Row label={t("uiKit.textarea")}>
            <Textarea aria-label={t("uiKit.sample.notes")} placeholder={t("uiKit.sample.task")} data-kit="textarea" />
            <Textarea aria-label={t("uiKit.sample.notes")} code defaultValue="npm test -- --run" />
          </Row>
        </Section>

        <Section id="select" title={t("uiKit.select")}>
          <Row label={t("uiKit.select")}>
            <Select aria-label={t("uiKit.sample.agent")} options={AGENTS(t("uiKit.sample.notInstalled"))} value={agent} onChange={setAgent} id="ui-kit-select" />
            <Select
              aria-label={t("uiKit.sample.agent")}
              options={AGENTS(t("uiKit.sample.notInstalled"))}
              value={empty}
              onChange={setEmpty}
              placeholder={t("uiKit.sample.pickAgent")}
              size="sm"
              id="ui-kit-select-sm"
            />
            <Select aria-label={t("uiKit.sample.agent")} options={AGENTS(t("uiKit.sample.notInstalled"))} value={agent} onChange={setAgent} disabled />
            <Select aria-label={t("uiKit.sample.agent")} options={AGENTS(t("uiKit.sample.notInstalled"))} value={agent} onChange={setAgent} invalid />
          </Row>
          <Row label={t("uiKit.nativeSelect")}>
            <NativeSelect aria-label={t("uiKit.sample.shell")} defaultValue="zsh" data-kit="native-select">
              {SHELLS.map((sh) => (
                <option key={sh} value={sh}>
                  {sh}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label={t("uiKit.sample.shell")} defaultValue="zsh" size="sm">
              <option value={SHELLS[0]}>{SHELLS[0]}</option>
            </NativeSelect>
          </Row>
          <Row label={t("uiKit.menu")}>
            <Menu
              label={t("uiKit.sample.moreActions")}
              renderTrigger={(p) => (
                <Button {...p} data-kit="menu-trigger">
                  {t("uiKit.sample.moreActions")}
                </Button>
              )}
              entries={[
                { id: "rename", label: t("uiKit.sample.rename"), shortcut: "F2", onSelect: () => setLastAction("rename") },
                { id: "duplicate", label: t("uiKit.sample.duplicate"), shortcut: "⌘D", onSelect: () => setLastAction("duplicate") },
                { id: "archive", label: t("uiKit.sample.archive"), disabled: true, onSelect: () => setLastAction("archive") },
                { id: "sep", separator: true },
                { id: "delete", label: t("uiKit.sample.deleteSession"), shortcut: "⌘⌫", danger: true, onSelect: () => setLastAction("delete") },
              ]}
            />
            {lastAction && <span className="ui-kit-note" data-kit="menu-last">{lastAction}</span>}
          </Row>
        </Section>

        <Section id="chips" title={t("uiKit.chips")}>
          <Row label={t("uiKit.chips")}>
            <Chip>{MODELS.opus}</Chip>
            <Chip selected={chipOn} onToggle={setChipOn}>
              {t("uiKit.sample.acceptEdits")}
            </Chip>
            <Chip selected={chipOff} onToggle={setChipOff}>
              {t("uiKit.sample.effortHigh")}
            </Chip>
            <Chip onRemove={() => {}} removeLabel={t("uiKit.sample.remove", { name: MODELS.opus })}>
              {MODELS.opus}
            </Chip>
            <Chip size="sm">{MODELS.sonnet}</Chip>
          </Row>
          <Row label={t("uiKit.segmented")}>
            <Segmented
              label={t("uiKit.segmented")}
              value={group}
              onChange={setGroup}
              options={[
                { value: "file", label: t("review.byFile") },
                { value: "turn", label: t("review.byTurn") },
                { value: "risky", label: t("uiKit.sample.risky") },
              ]}
            />
            <Segmented
              label={t("uiKit.segmented")}
              size="sm"
              value={groupSm}
              onChange={setGroupSm}
              options={[
                { value: "file", label: t("review.byFile") },
                { value: "turn", label: t("review.byTurn") },
                { value: "risky", label: t("uiKit.sample.risky"), disabled: true },
              ]}
            />
          </Row>
          <Row label={t("uiKit.tabs")}>
            <div className="ui-kit-tabs">
              <Tabs
                idPrefix="ui-kit-tabs"
                label={t("uiKit.tabs")}
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "review", label: t("review.tabReview") },
                  { value: "repo", label: t("review.tabRepository"), badge: <Counter value={3} /> },
                  { value: "wt", label: t("review.tabWorktrees") },
                ]}
              />
              <TabPanel idPrefix="ui-kit-tabs" value={tab} className="ui-kit-tab-panel">
                {t("uiKit.sample.panel")}
              </TabPanel>
            </div>
            <div className="ui-kit-vtabs">
              <Tabs
                idPrefix="ui-kit-vtabs"
                label={t("uiKit.tabs")}
                orientation="vertical"
                value={nav}
                onChange={setNav}
                tabs={[
                  { value: "general", label: t("settings.general") },
                  { value: "appearance", label: t("settings.appearance") },
                  { value: "flags", label: t("settings.flags") },
                ]}
              />
            </div>
          </Row>
        </Section>

        <Section id="choices" title={t("uiKit.choices")}>
          <Row label={t("uiKit.toggle")}>
            <Toggle label={t("uiKit.sample.statusLine")} checked={statusLine} onChange={setStatusLine} />
            <Toggle label={t("uiKit.sample.wrap")} checked={wrap} onChange={setWrap} />
            <Toggle label={t("uiKit.state.disabled")} checked disabled onChange={() => {}} />
          </Row>
          <Row label={t("uiKit.checkbox")}>
            <Checkbox label={t("uiKit.sample.stageFile")} checked={staged} onChange={setStaged} />
            <Checkbox label={t("uiKit.sample.notStaged")} checked={unstaged} onChange={setUnstaged} />
            <Checkbox label={t("uiKit.sample.allFiles")} checked={false} indeterminate onChange={() => {}} />
            <Checkbox label={t("uiKit.state.disabled")} checked disabled onChange={() => {}} />
          </Row>
          <Row label={t("uiKit.radio")}>
            <RadioGroup
              label={t("uiKit.radio")}
              value={where}
              onChange={setWhere}
              options={[
                { value: "new", label: t("uiKit.sample.newWorktree") },
                { value: "existing", label: t("uiKit.sample.existingBranch"), disabled: true },
                { value: "folder", label: t("uiKit.sample.thisFolder"), description: t("uiKit.sample.thisFolderHint") },
              ]}
            />
            <Radio name="ui-kit-loose" label={t("uiKit.state.default")} checked={false} onChange={() => {}} />
            <Radio name="ui-kit-loose" label={t("uiKit.state.selected")} checked onChange={() => {}} />
            <Radio name="ui-kit-loose-disabled" label={t("uiKit.state.disabled")} checked disabled onChange={() => {}} />
          </Row>
        </Section>

        <Section id="badges" title={t("uiKit.badges")}>
          <Row label={t("uiKit.badges")}>
            <Badge tone="success">{t("uiKit.sample.exact")}</Badge>
            <Badge tone="warning">{t("uiKit.sample.guessed")}</Badge>
            <Badge tone="danger">{t("uiKit.sample.rejected")}</Badge>
            <Badge tone="info">{t("uiKit.sample.beta")}</Badge>
            <Badge>{t("uiKit.sample.retired")}</Badge>
            <Counter value={3} />
            <Counter value={3} tone="attention" label={t("uiKit.sample.needYou", { count: 3 })} />
            <Counter value={128} />
          </Row>
        </Section>
      </div>
    </div>
  );
}
