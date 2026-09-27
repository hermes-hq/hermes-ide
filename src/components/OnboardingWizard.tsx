import "../styles/components/OnboardingWizard.css";
import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { getSetting, setSetting, getSettings } from "../api/settings";
import { checkAiProviders } from "../api/sessions";
import { applyTheme, applyUiScale, DARK_THEMES, LIGHT_THEMES, UI_SCALE_OPTIONS, normalizeThemeId, DEFAULT_THEME_ID } from "../utils/themeManager";
import { setAnalyticsEnabled } from "../utils/analytics";
import { installCommand, listAgents } from "../catalog/agentCatalog";

type Step = "welcome" | "theme" | "ai_setup" | "privacy";

const STEPS: Step[] = ["welcome", "theme", "ai_setup", "privacy"];

// Mini terminal preview colors per theme (bg, text, accent, green).  Values
// mirror the canonical `--bg-0`, `--text-1`, `--accent`, and `--green` tokens
// in `themes.css` for each of the eight v1.1.15 themes.  Keep in sync if a
// theme's tokens shift; the wizard renders a fixed `$ ~ ok` strip per card so
// only these four values matter for the swatch.
const THEME_PREVIEW: Record<string, { bg: string; text: string; accent: string; green: string }> = {
  // Dark themes
  "frosted-dark": { bg: "#1c1c1e", text: "#d6d6d9", accent: "#0a84ff", green: "#30d158" },
  atelier:        { bg: "#1a1714", text: "#c8bfb0", accent: "#e07850", green: "#8fbc6a" },
  observatory:    { bg: "#0a1018", text: "#c8b896", accent: "#d4a86a", green: "#6fa86f" },
  phosphor:       { bg: "#050805", text: "#80d878", accent: "#b0f0a8", green: "#b0f0a8" },
  // Light themes
  "frosted-light": { bg: "#f5f5f7", text: "#3a3a3c", accent: "#0a84ff", green: "#28a745" },
  linen:           { bg: "#f4ede0", text: "#4a3e30", accent: "#c45a32", green: "#5e8a40" },
  newsprint:       { bg: "#f7f4ec", text: "#2a2a2a", accent: "#0a0a0a", green: "#2a6a2a" },
  atrium:          { bg: "#eef2f6", text: "#4a5566", accent: "#4a6a8c", green: "#4a8a6a" },
};

const SETTING_KEY = "onboarding_completed";

export function OnboardingWizard() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("welcome");

  // Theme step
  const [selectedTheme, setSelectedTheme] = useState<string>(DEFAULT_THEME_ID);
  const [selectedScale, setSelectedScale] = useState("default");

  // AI setup step
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean>>({});
  const [detectionDone, setDetectionDone] = useState(false);

  // Privacy step
  const [analyticsOptIn, setAnalyticsOptIn] = useState(true);
  const [policyAccepted, setPolicyAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const val = await getSetting(SETTING_KEY);
        if (cancelled) return;
        if (val === "true") return; // already completed
      } catch {
        // Setting doesn't exist yet — first launch
      }
      if (!cancelled) {
        // Load current theme if already set
        try {
          const settings = await getSettings();
          if (settings.theme) setSelectedTheme(normalizeThemeId(settings.theme));
          if (settings.ui_scale) setSelectedScale(settings.ui_scale);
        } catch {
          // ignore
        }
        setVisible(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (step === "ai_setup" && !detectionDone) {
      checkAiProviders()
        .then((r) => { setProviderAvailability(r); setDetectionDone(true); })
        .catch(() => setDetectionDone(true));
    }
  }, [step, detectionDone]);

  const currentStepIdx = STEPS.indexOf(step);

  const goNext = useCallback(() => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  }, [step]);

  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  }, [step]);

  const handleThemeSelect = useCallback(async (themeId: string) => {
    setSelectedTheme(themeId);
    await setSetting("theme", themeId).catch(console.warn);
    try {
      const settings = await getSettings();
      applyTheme(themeId, settings);
    } catch {
      applyTheme(themeId, {});
    }
  }, []);

  const handleScaleChange = useCallback(async (scaleId: string) => {
    setSelectedScale(scaleId);
    await setSetting("ui_scale", scaleId).catch(console.warn);
    applyUiScale(scaleId, selectedTheme);
  }, [selectedTheme]);

  const handleFinish = useCallback(async () => {
    // Save analytics preference
    const telemetryValue = analyticsOptIn ? "true" : "false";
    await setSetting("telemetry_enabled", telemetryValue).catch(console.warn);
    setAnalyticsEnabled(analyticsOptIn);

    // Mark onboarding as completed
    await setSetting(SETTING_KEY, "true").catch(console.warn);

    setVisible(false);
  }, [analyticsOptIn]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (step === "welcome") goNext();
      else if (step === "theme") goNext();
      else if (step === "ai_setup") goNext();
      else if (step === "privacy" && policyAccepted) handleFinish();
    }
  }, [step, goNext, policyAccepted, handleFinish]);

  if (!visible) return null;

  return (
    <div className="onboarding-backdrop" onKeyDown={handleKeyDown}>
      <div className="onboarding-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header — hidden on welcome step */}
        {step !== "welcome" && (
          <div className="onboarding-header">
            <span className="onboarding-header-title">
              {step === "theme" ? "Personalize" : step === "ai_setup" ? "AI Tools" : "Privacy & Data"}
            </span>
            <span className="onboarding-header-step">
              Step {currentStepIdx + 1} of {STEPS.length}
            </span>
          </div>
        )}

        {/* Body */}
        <div className="onboarding-body">
          {/* ── Step 1: Welcome ── */}
          {step === "welcome" && (
            <div className="onboarding-welcome">
              <div className="onboarding-logo">Hermes IDE</div>
              <p className="onboarding-tagline">
                AI-powered terminal emulator for developers. Wrap your existing
                shell with AI superpowers — ghost-text suggestions, prompt
                composer, git management, file explorer, and cost tracking.
              </p>
              <span className="onboarding-early-access">
                Free
              </span>
            </div>
          )}

          {/* ── Step 2: Theme ── */}
          {step === "theme" && (
            <>
              <div className="onboarding-section-label">Dark</div>
              <div className="onboarding-theme-grid">
                {DARK_THEMES.map((t) => {
                  const p = THEME_PREVIEW[t.id];
                  return (
                    <button
                      key={t.id}
                      className={`onboarding-theme-card ${selectedTheme === t.id ? "selected" : ""}`}
                      onClick={() => handleThemeSelect(t.id)}
                      title={t.label}
                    >
                      <div
                        className="onboarding-theme-preview"
                        style={{ background: p?.bg ?? "#111" }}
                      >
                        <span style={{ color: p?.text ?? "#ccc" }}>$</span>
                        <span style={{ color: p?.accent ?? "#77f" }}>~</span>
                        <span style={{ color: p?.green ?? "#4d4" }}>ok</span>
                      </div>
                      <span className="onboarding-theme-card-name">{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="onboarding-section-label">Light</div>
              <div className="onboarding-theme-grid">
                {LIGHT_THEMES.map((t) => {
                  const p = THEME_PREVIEW[t.id];
                  return (
                    <button
                      key={t.id}
                      className={`onboarding-theme-card ${selectedTheme === t.id ? "selected" : ""}`}
                      onClick={() => handleThemeSelect(t.id)}
                      title={t.label}
                    >
                      <div
                        className="onboarding-theme-preview"
                        style={{ background: p?.bg ?? "#fff" }}
                      >
                        <span style={{ color: p?.text ?? "#333" }}>$</span>
                        <span style={{ color: p?.accent ?? "#26e" }}>~</span>
                        <span style={{ color: p?.green ?? "#1a4" }}>ok</span>
                      </div>
                      <span className="onboarding-theme-card-name">{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="onboarding-section-label">UI Scale</div>
              <div className="onboarding-scale-row">
                <select
                  value={selectedScale}
                  onChange={(e) => handleScaleChange(e.target.value)}
                >
                  {UI_SCALE_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* ── Step 3: AI Setup ── */}
          {step === "ai_setup" && (
            <>
              <div className="onboarding-section-label">Detected AI tools</div>
              <div className="onboarding-ai-grid">
                {listAgents().map((p) => {
                  const available = providerAvailability[p.id];
                  return (
                    <div
                      key={p.id}
                      className={`onboarding-ai-card ${detectionDone && !available ? "missing" : ""}`}
                    >
                      <div className="onboarding-ai-card-header">
                        <span className="onboarding-ai-card-name">{p.name}</span>
                        {detectionDone ? (
                          <span className={`onboarding-ai-status ${available ? "installed" : "missing"}`}>
                            {available ? "Detected" : "Not found"}
                          </span>
                        ) : (
                          <span className="onboarding-ai-status checking">Checking...</span>
                        )}
                      </div>
                      <div className="onboarding-ai-card-desc">{p.description}</div>
                      {detectionDone && !available && (
                        <code className="onboarding-ai-install-cmd">{installCommand(p)}</code>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="onboarding-ai-note">
                You can use Hermes as a terminal without AI tools. Install them anytime.
              </div>
            </>
          )}

          {/* ── Step 4: Privacy ── */}
          {step === "privacy" && (
            <>
              <div className="onboarding-privacy-section">
                <div className="onboarding-privacy-section-title">
                  What we collect (anonymously)
                </div>
                <ul className="onboarding-privacy-list collect">
                  <li>App version and operating system</li>
                  <li>Feature usage counts (e.g. which panels you open)</li>
                  <li>Session creation events (no content)</li>
                </ul>
              </div>
              <div className="onboarding-privacy-section">
                <div className="onboarding-privacy-section-title">
                  What we never collect
                </div>
                <ul className="onboarding-privacy-list never">
                  <li>Terminal content, commands, or output</li>
                  <li>File paths, file names, or source code</li>
                  <li>Personal information or IP addresses</li>
                </ul>
              </div>

              <label className="onboarding-privacy-checkbox">
                <input
                  type="checkbox"
                  checked={analyticsOptIn}
                  onChange={(e) => setAnalyticsOptIn(e.target.checked)}
                />
                <div className="onboarding-privacy-checkbox-text">
                  <span className="onboarding-privacy-checkbox-label">
                    Help improve Hermes IDE by sending anonymous usage analytics
                  </span>
                  <span className="onboarding-privacy-checkbox-hint">
                    You can change this anytime in Settings &gt; Privacy
                  </span>
                </div>
              </label>

              <label className="onboarding-privacy-checkbox">
                <input
                  type="checkbox"
                  checked={policyAccepted}
                  onChange={(e) => setPolicyAccepted(e.target.checked)}
                />
                <div className="onboarding-privacy-checkbox-text">
                  <span className="onboarding-privacy-checkbox-label">
                    I accept the{" "}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        open("https://hermes-ide.com/legal");
                      }}
                    >
                      Privacy Policy
                    </a>
                  </span>
                </div>
              </label>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="onboarding-footer">
          <div className="onboarding-dots">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`onboarding-dot ${i <= currentStepIdx ? "active" : ""}`}
              />
            ))}
          </div>
          <div className="onboarding-actions">
            {step === "welcome" && (
              <button
                className="onboarding-btn onboarding-btn-primary"
                onClick={goNext}
              >
                Get Started
              </button>
            )}
            {step === "theme" && (
              <>
                <button className="onboarding-btn" onClick={goBack}>
                  Back
                </button>
                <button
                  className="onboarding-btn onboarding-btn-primary"
                  onClick={goNext}
                >
                  Next
                </button>
              </>
            )}
            {step === "ai_setup" && (
              <>
                <button className="onboarding-btn" onClick={goBack}>
                  Back
                </button>
                <button
                  className="onboarding-btn onboarding-btn-primary"
                  onClick={goNext}
                >
                  Next
                </button>
              </>
            )}
            {step === "privacy" && (
              <>
                <button className="onboarding-btn" onClick={goBack}>
                  Back
                </button>
                <button
                  className="onboarding-btn onboarding-btn-primary"
                  onClick={handleFinish}
                  disabled={!policyAccepted}
                >
                  Finish
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
