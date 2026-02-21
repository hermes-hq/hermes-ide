import { useState, useEffect } from "react";

interface HermesDaemonProps {
  mode: "full" | "watermark";
  assembling?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// HERMES DAEMON — 24x24 Pixel Sprite  (v4 — head with petasos)
// ═══════════════════════════════════════════════════════════════
//
//   Hermes' head wearing the winged petasos hat.
//
//   Legend:
//     0 = transparent
//     1 = hat green (#33ff99)        — petasos, bright phosphor
//     2 = wing violet (#a78bfa)      — hat wings
//     3 = eyes amber (#ffb000)       — spark of life
//     4 = skin grey (#8896a0)        — cool neutral skin
//     5 = hair dark (#4a5568)        — dark hair/shadow
//
//   Anatomy (rows 1-14):
//     R1:     Wing tips (small, pointing up)
//     R2:     Wings + hat crown top (6px dome)
//     R3:     Wings + hat crown (8px)
//     R4:     Wings + hat brim (widest, 12px hat + wings)
//     R5:     Hat brim bottom (14px)
//     R6:     Hair line (12px)
//     R7:     Hair sides + forehead (skin 8px, hair 2px each side)
//     R8:     Face (10px)
//     R9:     Eyes — 1px amber each, spaced (10px)
//     R10-11: Face / lower face (10px)
//     R12:    Chin (8px)
//     R13:    Jaw (6px)
//     R14:    Neck (4px)
//
// ═══════════════════════════════════════════════════════════════

const FRAMES = {
  idle: [
    "000000000000000000000000", // 0
    "000200000000000000002000", // 1  wing tips (cols 3, 20)
    "000220000111111000220000", // 2  wings + crown top (6px)
    "000022001111111100220000", // 3  wings + crown (8px)
    "000022111111111111220000", // 4  wings + brim (12px)
    "000001111111111111100000", // 5  brim bottom (14px)
    "000000555555555555000000", // 6  hair line
    "000000554444444455000000", // 7  hair sides + forehead
    "000000044444444440000000", // 8  face
    "000000044344443440000000", // 9  eyes (amber at 9, 14)
    "000000044444444440000000", // 10 face
    "000000044444444440000000", // 11 lower face
    "000000004444444400000000", // 12 chin
    "000000000444444000000000", // 13 jaw
    "000000000044440000000000", // 14 neck
    "000000000000000000000000", // 15
  ],
  blink: [
    "000000000000000000000000", // 0
    "000200000000000000002000", // 1
    "000220000111111000220000", // 2
    "000022001111111100220000", // 3
    "000022111111111111220000", // 4
    "000001111111111111100000", // 5
    "000000555555555555000000", // 6
    "000000554444444455000000", // 7
    "000000044444444440000000", // 8
    "000000044444444440000000", // 9  eyes OFF (blink)
    "000000044444444440000000", // 10
    "000000044444444440000000", // 11
    "000000004444444400000000", // 12
    "000000000444444000000000", // 13
    "000000000044440000000000", // 14
    "000000000000000000000000", // 15
  ],
  wingUp: [
    "000200000000000000002000", // 0  tips shifted UP
    "000220000000000000022000", // 1  tier 2 (wings only)
    "000022000111111000220000", // 2  tier 3 + crown top
    "000022001111111100220000", // 3  base + crown (= idle R3)
    "000000111111111111000000", // 4  brim only (wings cleared)
    "000001111111111111100000", // 5  brim bottom
    "000000555555555555000000", // 6  hair
    "000000554444444455000000", // 7  hair + forehead
    "000000044444444440000000", // 8  face
    "000000044344443440000000", // 9  eyes
    "000000044444444440000000", // 10
    "000000044444444440000000", // 11
    "000000004444444400000000", // 12
    "000000000444444000000000", // 13
    "000000000044440000000000", // 14
    "000000000000000000000000", // 15
  ],
  wingDown: [
    "000000000000000000000000", // 0
    "000000000000000000000000", // 1  (wings moved down, empty)
    "000200000111111000002000", // 2  tips + crown top
    "000220001111111100022000", // 3  tier 2 + crown
    "000022111111111111220000", // 4  tier 3 + brim (= idle R4)
    "000022111111111111220000", // 5  base + brim
    "000000555555555555000000", // 6  hair
    "000000554444444455000000", // 7  hair + forehead
    "000000044444444440000000", // 8  face
    "000000044344443440000000", // 9  eyes
    "000000044444444440000000", // 10
    "000000044444444440000000", // 11
    "000000004444444400000000", // 12
    "000000000444444000000000", // 13
    "000000000044440000000000", // 14
    "000000000000000000000000", // 15
  ],
};

const COLORS: Record<string, string> = {
  "1": "#33ff99", // hat — phosphor green
  "2": "#a78bfa", // wings — soft violet
  "3": "#ffb000", // eyes — amber glow
  "4": "#8896a0", // skin — cool grey
  "5": "#4a5568", // hair — dark grey
};

function renderFrame(frame: string[], size: number, visibleRows?: number) {
  const rows = visibleRows != null ? frame.slice(0, visibleRows) : frame;
  const cellSize = size / 24;
  const rects: JSX.Element[] = [];

  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c !== "0") {
        rects.push(
          <rect
            key={`${x}-${y}`}
            x={x * cellSize}
            y={y * cellSize}
            width={cellSize}
            height={cellSize}
            fill={COLORS[c] || "transparent"}
          />
        );
      }
    }
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} xmlns="http://www.w3.org/2000/svg">
      {rects}
    </svg>
  );
}

export function HermesDaemon({ mode, assembling }: HermesDaemonProps) {
  const [frame, setFrame] = useState<"idle" | "blink" | "wingUp" | "wingDown">("idle");
  const [assembleRows, setAssembleRows] = useState(assembling ? 0 : FRAMES.idle.length);
  const [showSpark, setShowSpark] = useState(false);

  // Assembly animation — reveal rows one by one
  useEffect(() => {
    if (!assembling) return;
    if (assembleRows >= FRAMES.idle.length) return;
    const timer = setTimeout(() => setAssembleRows((r) => r + 1), 60);
    return () => clearTimeout(timer);
  }, [assembling, assembleRows]);

  // Idle animation cycle
  useEffect(() => {
    if (assembling && assembleRows < FRAMES.idle.length) return;

    // Wing flutter: idle → wingUp → idle → wingDown (2s cycle)
    const flutterInterval = setInterval(() => {
      setFrame("wingUp");
      setTimeout(() => setFrame("idle"), 250);
      setTimeout(() => setFrame("wingDown"), 500);
      setTimeout(() => setFrame("idle"), 750);
    }, 2000);

    // Blink every ~4s
    const blinkInterval = setInterval(() => {
      setFrame("blink");
      setTimeout(() => setFrame("idle"), 150);
    }, 4000);

    return () => {
      clearInterval(flutterInterval);
      clearInterval(blinkInterval);
    };
  }, [assembling, assembleRows]);

  // Spark animation — amber dot above helmet
  useEffect(() => {
    const sparkInterval = setInterval(() => {
      setShowSpark(true);
      setTimeout(() => setShowSpark(false), 800);
    }, 6000);
    return () => clearInterval(sparkInterval);
  }, []);

  const size = mode === "watermark" ? 16 : 96;
  const isAssembling = assembling && assembleRows < FRAMES.idle.length;

  return (
    <div className={`hermes-daemon ${mode === "watermark" ? "hermes-watermark" : "hermes-float"}`}>
      {renderFrame(FRAMES[isAssembling ? "idle" : frame], size, isAssembling ? assembleRows : undefined)}
      {showSpark && !isAssembling && <div className="hermes-spark" />}
    </div>
  );
}
