import "../styles/components/OnboardingWizard.css";
import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { getSetting, setSetting, getSettings } from "../api/settings";
import { checkAiProviders } from "../api/sessions";
import { applyTheme, applyUiScale, DARK_THEMES, LIGHT_THEMES, UI_SCALE_OPTIONS } from "../utils/themeManager";
import { setAnalyticsEnabled } from "../utils/analytics";
import { AI_PROVIDERS } from "../utils/aiProviders";

type Step = "welcome" | "theme" | "ai_setup" | "privacy";

const STEPS: Step[] = ["welcome", "theme", "ai_setup", "privacy"];

// Mini terminal preview colors per theme (bg, text, accent, green)
const THEME_PREVIEW: Record<string, { bg: string; text: string; accent: string; green: string }> = {
  // Dark themes
  dark:             { bg: "#0B0F14", text: "#c8d6e5", accent: "#7b93db", green: "#34d399" },
  "frosted-dark":   { bg: "#1e1e1e", text: "#e5e5ea", accent: "#0a84ff", green: "#30d158" },
  hacker:           { bg: "#0a0a0a", text: "#33ff99", accent: "#33ff99", green: "#33ff99" },
  nightowl:         { bg: "#010104", text: "#d6d6f0", accent: "#a78bfa", green: "#66e0a3" },
  tron:             { bg: "#030810", text: "#d0f0ff", accent: "#00dffc", green: "#00ffaa" },
  duel:             { bg: "#0a0a0a", text: "#e0e0e0", accent: "#ff4444", green: "#33ff77" },
  "80s":            { bg: "#1a0a1a", text: "#ffcc00", accent: "#ff6600", green: "#33ff99" },
  midnight:         { bg: "#000080", text: "#d0d8e8", accent: "#1a6caa", green: "#33cc33" },
  "neon-sunset":    { bg: "#1e1f1c", text: "#cfcfc2", accent: "#66d9ef", green: "#a6e22e" },
  polar:            { bg: "#242933", text: "#d8dee9", accent: "#88c0d0", green: "#a3be8c" },
  reactor:          { bg: "#1e2127", text: "#9da5b4", accent: "#61afef", green: "#98c379" },
  amber:            { bg: "#1d2021", text: "#d5c4a1", accent: "#fe8019", green: "#b8bb26" },
  macchiato:        { bg: "#1e1e2e", text: "#bac2de", accent: "#cba6f7", green: "#a6e3a1" },
  shibuya:          { bg: "#16161e", text: "#a9b1d6", accent: "#7aa2f7", green: "#9ece6a" },
  "solarized-dark": { bg: "#001e26", text: "#839496", accent: "#268bd2", green: "#859900" },
  evergreen:        { bg: "#272e33", text: "#bfb49a", accent: "#a7c080", green: "#a7c080" },
  cobalt:           { bg: "#122738", text: "#bbcee8", accent: "#ffc600", green: "#3ad900" },
  "minimal-dark":   { bg: "#0d1117", text: "#c9d1d9", accent: "#58a6ff", green: "#3fb950" },
  transilvania:     { bg: "#1e1f29", text: "#ccccd6", accent: "#bd93f9", green: "#50fa7b" },
  rainbow:          { bg: "#0f0a14", text: "#e0d6f0", accent: "#ff6b9d", green: "#34d399" },
  data:             { bg: "#0a0e1a", text: "#c8d8f0", accent: "#22d3ee", green: "#34d399" },
  corporate:        { bg: "#111418", text: "#d4d8e0", accent: "#4a90d9", green: "#48c78e" },
  designer:         { bg: "#1a1714", text: "#e8e0d4", accent: "#e07850", green: "#8fbc6a" },
  // Light themes
  light:            { bg: "#ffffff", text: "#1a1a2e", accent: "#2563eb", green: "#16a34a" },
  "frosted-light":  { bg: "#ffffff", text: "#333336", accent: "#007aff", green: "#28cd41" },
  solarized:        { bg: "#fdf6e3", text: "#586e75", accent: "#268bd2", green: "#859900" },
  rose:             { bg: "#fdf8f8", text: "#2c2024", accent: "#c75580", green: "#5a9e6f" },
  lavender:         { bg: "#f9f7fd", text: "#1e1a2e", accent: "#7c4dff", green: "#4caf6a" },
  mint:             { bg: "#f6fcfa", text: "#1a2c26", accent: "#0d9668", green: "#12a35c" },
  sand:             { bg: "#faf8f4", text: "#2a2520", accent: "#c06a30", green: "#5a9952" },
};

const SETTING_KEY = "onboarding_completed";

export function OnboardingWizard() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("welcome");

  // Theme step
  const [selectedTheme, setSelectedTheme] = useState("frosted-dark");
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
                {AI_PROVIDERS.map((p) => {
                  const available = providerAvailability[p.id];
                  return (
                    <div
                      key={p.id}
                      className={`onboarding-ai-card ${detectionDone && !available ? "missing" : ""}`}
                    >
                      <div className="onboarding-ai-card-header">
                        <span className="onboarding-ai-card-name">{p.label}</span>
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
                        <code className="onboarding-ai-install-cmd">{p.installCmd}</code>
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
