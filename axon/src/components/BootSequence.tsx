import { useState, useEffect, useRef } from "react";
import { HermesDaemon } from "./HermesDaemon";

interface BootSequenceProps {
  onComplete: () => void;
}

const BOOT_LINES = [
  "HERMES-IDEA TERMINAL v0.1.0",
  "Initializing PTY subsystem..........OK",
  "Loading session database...........OK",
  "Scanning projects..................OK",
  "Context engine ready...............OK",
];

type Phase = "text" | "assemble" | "spark" | "idle" | "done";

export function BootSequence({ onComplete }: BootSequenceProps) {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("text");
  const [fadeOut, setFadeOut] = useState(false);
  const lineIndex = useRef(0);

  // Phase 1: Typewriter text (0-1.5s)
  useEffect(() => {
    if (phase !== "text") return;

    const interval = setInterval(() => {
      if (lineIndex.current < BOOT_LINES.length) {
        setVisibleLines((prev) => [...prev, BOOT_LINES[lineIndex.current]]);
        lineIndex.current++;
      } else {
        clearInterval(interval);
        setPhase("assemble");
      }
    }, 280);

    return () => clearInterval(interval);
  }, [phase]);

  // Phase 2: Daemon assembles (1.5-2.5s)
  useEffect(() => {
    if (phase !== "assemble") return;
    const timer = setTimeout(() => setPhase("spark"), 1200);
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase 3: Spark (2.5-3s)
  useEffect(() => {
    if (phase !== "spark") return;
    const timer = setTimeout(() => setPhase("idle"), 500);
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase 4: Idle + fade out (3-3.5s)
  useEffect(() => {
    if (phase !== "idle") return;
    const timer = setTimeout(() => {
      setFadeOut(true);
      setTimeout(() => {
        setPhase("done");
        onComplete();
      }, 500);
    }, 500);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  if (phase === "done") return null;

  return (
    <div className={`boot-sequence ${fadeOut ? "boot-fade-out" : ""}`}>
      <div className="boot-text">
        {visibleLines.map((line, i) => (
          <div key={i} className="boot-line">{line}</div>
        ))}
        {phase === "text" && <span className="boot-cursor">_</span>}
      </div>

      {(phase === "assemble" || phase === "spark" || phase === "idle") && (
        <div style={{ marginTop: 24 }}>
          <HermesDaemon mode="full" assembling={phase === "assemble"} />
        </div>
      )}
    </div>
  );
}
