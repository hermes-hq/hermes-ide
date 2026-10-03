// The Library in a small space: search, pick, fill the arguments, insert.
// Used by the task launcher ("From library") and the prompt Builder's
// Library tab. Rows are filtered to the agents the launch uses.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { useLibraryMessages } from "../../library/messages";
import { libraryGet, libraryRecordUse, librarySearch, libraryStatus } from "../../library/api";
import { argsOf, defaultValues, loadCore, missingRequired, renderWith } from "../../library/render";
import type { EntryDetail, LibraryHit } from "../../library/types";
import { HitRow } from "./LibraryParts";

export interface LibraryPick {
  kind: LibraryHit["kind"];
  id: string;
  version: string;
  title: string;
  /** Rendered with the arguments filled (a persona: as a role). */
  text: string;
}

type Core = Awaited<ReturnType<typeof loadCore>>;

export function LibraryPicker({
  works,
  kinds,
  onPick,
  embedded = false,
}: {
  /** hodios targets the launch uses: rows must work in one of them. */
  works?: string[];
  /** Restrict to these kinds (the launcher: prompts, workflows, personas). */
  kinds?: LibraryHit["kind"][];
  onPick: (pick: LibraryPick) => void;
  /** Inside another panel (the Builder) rather than a popover. */
  embedded?: boolean;
}) {
  const ready = useLibraryMessages();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LibraryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [core, setCore] = useState<Core | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ok, setOk] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    // The first open imports the bundled catalog.
    libraryStatus()
      .then((s) => setOk(s.ready))
      .catch(() => setOk(false));
    loadCore()
      .then(setCore)
      .catch(() => {});
  }, []);

  const filters = useMemo(() => {
    const f: Record<string, string[]> = {};
    if (works && works.length > 0) f.works = works;
    if (kinds && kinds.length > 0) f.kind = kinds;
    return f;
  }, [works, kinds]);

  useEffect(() => {
    if (!ok) return;
    const n = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      librarySearch({ query, filters, limit: 50, sort: "you" }, { works })
        .then((page) => {
          if (n === seq.current) setHits(page.hits);
        })
        .catch(() => {})
        .finally(() => n === seq.current && setLoading(false));
    }, 80);
    return () => clearTimeout(timer);
  }, [ok, query, filters, works]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    libraryGet(selected)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setValues(defaultValues(d.body));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [selected]);

  const text = useMemo(() => {
    if (!detail?.body || !core) return "";
    try {
      return renderWith(core, detail.body, values);
    } catch {
      return detail.body.body;
    }
  }, [detail, core, values]);

  if (!ready) return null;
  const missing = missingRequired(detail?.body, values);
  const isPersona = detail?.row.kind === "persona";
  return (
    <div className={embedded ? "lib-picker lib-picker--embedded" : "lib-picker"} data-testid="library-picker">
      <Input
        size="sm"
        type="search"
        className="lib-picker-search"
        aria-label={t("library.search.label")}
        placeholder={t("library.picker.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="lib-picker-body">
        <div className="lib-picker-list" role="listbox" aria-label={t("library.results.label")} aria-busy={loading}>
          {hits.map((h) => (
            <HitRow
              key={h.id}
              id={h.id}
              kind={h.kind}
              title={h.title}
              description={h.description}
              meta={h.categoryLabel}
              selected={h.id === selected}
              onOpen={() => setSelected(h.id)}
            />
          ))}
          {!loading && hits.length === 0 && <p className="lib-muted">{ok ? t("library.results.none", { query }) : t("library.preparing")}</p>}
        </div>
        {detail && (
          <div className="lib-picker-detail" data-entry={detail.id}>
            <b>{detail.row.title}</b>
            {argsOf(detail.body).map((a) => (
              <label key={a.name} className="lib-field" data-arg={a.name}>
                <span className="lib-field-label">
                  <span className="lib-field-name">{a.name}</span>
                  {a.required && a.default === undefined && <span className="lib-field-required">{t("library.detail.required")}</span>}
                </span>
                <Input size="sm" value={values[a.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))} placeholder={a.description} />
              </label>
            ))}
            <pre className="lib-preview">{text}</pre>
            {missing.length > 0 && <p className="lib-blocked">{t("library.detail.fillFirst", { name: missing.join(", ") })}</p>}
            <Button
              variant="primary"
              size="sm"
              className="lib-picker-insert"
              disabled={!text || missing.length > 0}
              onClick={() => {
                void libraryRecordUse(detail.id);
                onPick({ kind: detail.row.kind, id: detail.id, version: detail.row.v, title: detail.row.title, text });
              }}
            >
              {isPersona ? t("library.picker.actAs") : t("library.picker.insert")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
