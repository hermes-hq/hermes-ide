import "../styles/components/OnboardingWizard.css";
import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { getSetting, setSetting, getSettings } from "../api/settings";
import { applyTheme, applyUiScale, THEME_OPTIONS, UI_SCALE_OPTIONS } from "../utils/themeManager";
import { setAnalyticsEnabled } from "../utils/analytics";

type Step = "welcome" | "theme" | "privacy";

const STEPS: Step[] = ["welcome", "theme", "privacy"];

// Mini terminal preview colors per theme (bg, text, accent, green)
const THEME_PREVIEW: Record<string, { bg: string; text: string; accent: string; green: string }> = {
  dark:      { bg: "#0B0F14", text: "#c8d6e5", accent: "#7b93db", green: "#34d399" },
  hacker:    { bg: "#0a0a0a", text: "#33ff99", accent: "#33ff99", green: "#33ff99" },
  designer:  { bg: "#1a1714", text: "#e8e0d4", accent: "#e07850", green: "#8fbc6a" },
  data:      { bg: "#0a0e1a", text: "#c8d8f0", accent: "#22d3ee", green: "#34d399" },
  corporate: { bg: "#111418", text: "#d4d8e0", accent: "#4a90d9", green: "#48c78e" },
  nightowl:  { bg: "#010104", text: "#d6d6f0", accent: "#a78bfa", green: "#66e0a3" },
  tron:      { bg: "#030810", text: "#d0f0ff", accent: "#00dffc", green: "#00ffaa" },
  duel:      { bg: "#0a0a0a", text: "#e0e0e0", accent: "#ff4444", green: "#33ff77" },
  rainbow:   { bg: "#0f0a14", text: "#e0d6f0", accent: "#ff6b9d", green: "#34d399" },
  "80s":     { bg: "#1a0a1a", text: "#ffcc00", accent: "#ff6600", green: "#33ff99" },
  solarized: { bg: "#fdf6e3", text: "#586e75", accent: "#268bd2", green: "#859900" },
};

const SETTING_KEY = "onboarding_completed";

export function OnboardingWizard() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("welcome");

  // Theme step
  const [selectedTheme, setSelectedTheme] = useState("tron");
  const [selectedScale, setSelectedScale] = useState("default");

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
          if (settings.theme) setSelectedTheme(settings.theme);
          if (settings.ui_scale) setSelectedScale(settings.ui_scale);
        } catch {
          // ignore
        }
        setVisible(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
              {step === "theme" ? "Personalize" : "Privacy & Data"}
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
                Free during early access
              </span>
            </div>
          )}

          {/* ── Step 2: Theme ── */}
          {step === "theme" && (
            <>
              <div className="onboarding-section-label">Choose a theme</div>
              <div className="onboarding-theme-grid">
                {THEME_OPTIONS.map((t) => {
                  const p = THEME_PREVIEW[t.id];
                  return (
                    <button
                      key={t.id}
                      className={`onboarding-theme-card ${selectedTheme === t.id ? "selected" : ""}`}
                      onClick={() => handleThemeSelect(t.id)}
                    >
                      {p && (
                        <div
                          className="onboarding-theme-preview"
                          style={{ background: p.bg }}
                        >
                          <span style={{ color: p.text }}>$</span>
                          <span style={{ color: p.accent }}>~</span>
                          <span style={{ color: p.green }}>ok</span>
                        </div>
                      )}
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

          {/* ── Step 3: Privacy ── */}
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
