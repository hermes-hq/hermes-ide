import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Realm, useSessionRealms } from "../hooks/useSessionRealms";

const LANGUAGE_COLORS: Record<string, string> = {
  "JavaScript/TypeScript": "#f1e05a",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Python: "#3572a5",
  Go: "#00ADD8",
  Ruby: "#701516",
  Java: "#b07219",
  PHP: "#4F5D95",
  Dart: "#00B4AB",
  Swift: "#F05138",
  "C#": "#178600",
};

interface RealmPickerProps {
  sessionId: string;
  onClose: () => void;
}

export function RealmPicker({ sessionId, onClose }: RealmPickerProps) {
  const { realms: attachedRealms, attach, detach } = useSessionRealms(sessionId);
  const [allRealms, setAllRealms] = useState<Realm[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke("get_realms")
      .then((r) => setAllRealms(r as Realm[]))
      .catch((err) => console.warn("[RealmPicker] Failed to load realms:", err));
    inputRef.current?.focus();
  }, []);

  const attachedIds = useMemo(
    () => new Set(attachedRealms.map((r) => r.id)),
    [attachedRealms]
  );

  const filtered = useMemo(() => {
    if (!query) return allRealms;
    const q = query.toLowerCase();
    return allRealms.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.languages.some((l) => l.toLowerCase().includes(q))
    );
  }, [query, allRealms]);

  const toggleRealm = async (realm: Realm) => {
    if (attachedIds.has(realm.id)) {
      await detach(realm.id);
    } else {
      await attach(realm.id);
    }
    // Refresh all realms in case of updates
    invoke("get_realms")
      .then((r) => setAllRealms(r as Realm[]))
      .catch((err) => console.warn("[RealmPicker] Failed to refresh realms:", err));
  };

  const scanNewPath = async (path: string) => {
    if (!path.trim()) return;
    setScanning(true);
    try {
      const realm = await invoke("create_realm", {
        path: path.trim(),
        name: null,
      }) as Realm;
      setAllRealms((prev) => [realm, ...prev.filter((r) => r.id !== realm.id)]);
      await attach(realm.id);
      setScanPath("");
    } catch (err) {
      console.error("Failed to create realm:", err);
    } finally {
      setScanning(false);
    }
  };

  const handleScanNew = () => scanNewPath(scanPath);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await scanNewPath(selected);
    }
  };

  const shortPath = (p: string) => {
    const home = p.replace(/^\/Users\/[^/]+/, "~");
    return home.length > 50 ? "..." + home.slice(-47) : home;
  };

  const scanStatusLabel = (status: string) => {
    switch (status) {
      case "pending": return "...";
      case "surface": return "S";
      case "deep": return "D";
      case "full": return "F";
      default: return status;
    }
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="realm-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="realm-picker-header">
          <span className="realm-picker-title">Projects</span>
          <span className="realm-picker-count">
            {attachedRealms.length} attached
          </span>
          <button className="settings-close" onClick={onClose}>
            x
          </button>
        </div>

        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Filter projects..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />

        <div className="realm-picker-body">
          {filtered.length === 0 && !query && (
            <div className="workspace-empty">
              No projects found. Scan a directory below to add one.
            </div>
          )}
          {filtered.length === 0 && query && (
            <div className="command-palette-empty">
              No projects matching "{query}"
            </div>
          )}
          {filtered.map((realm) => (
            <div
              key={realm.id}
              className={`realm-picker-item ${attachedIds.has(realm.id) ? "realm-picker-item-attached" : ""}`}
              onClick={() => toggleRealm(realm)}
            >
              <span className="realm-picker-check">
                {attachedIds.has(realm.id) ? "[x]" : "[ ]"}
              </span>
              <div className="realm-picker-info">
                <div className="realm-picker-name">
                  {realm.name}
                  <span className="realm-picker-scan-badge" data-status={realm.scan_status}>
                    {scanStatusLabel(realm.scan_status)}
                  </span>
                </div>
                <div className="realm-picker-path">{shortPath(realm.path)}</div>
                <div className="realm-picker-tags">
                  {realm.languages.map((lang) => (
                    <span
                      key={lang}
                      className="workspace-lang-tag"
                      style={{
                        color: LANGUAGE_COLORS[lang] || "#7b93db",
                        borderColor: (LANGUAGE_COLORS[lang] || "#7b93db") + "66",
                      }}
                    >
                      {lang}
                    </span>
                  ))}
                  {realm.frameworks.map((fw) => (
                    <span key={fw} className="workspace-fw-tag">{fw}</span>
                  ))}
                </div>
              </div>
              <button
                className="realm-picker-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  invoke("delete_realm", { id: realm.id }).then(() => {
                    setAllRealms((prev) => prev.filter((r) => r.id !== realm.id));
                  }).catch(console.error);
                }}
                title="Delete project"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="realm-picker-footer">
          <input
            className="workspace-scan-input"
            placeholder="Path or browse..."
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleScanNew(); }}
          />
          <button
            className="workspace-scan-btn"
            onClick={handleBrowse}
            disabled={scanning}
            title="Browse for folder"
          >
            {scanning ? "..." : "Browse"}
          </button>
          <button
            className="workspace-scan-btn"
            onClick={handleScanNew}
            disabled={scanning || !scanPath.trim()}
          >
            Scan
          </button>
        </div>
      </div>
    </div>
  );
}
