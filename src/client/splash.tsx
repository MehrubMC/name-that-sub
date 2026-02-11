// src/client/splash.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

type GameMode = "easy" | "medium" | "hard";

function normalizeMode(raw: unknown): GameMode {
  const s = String(raw ?? "").toLowerCase();
  if (s === "easy" || s === "medium" || s === "hard") return s;
  return "medium";
}

function SplashApp() {
  const [mode, setMode] = useState<GameMode>(() => {
    const saved = localStorage.getItem("nts:mode");
    return normalizeMode(saved);
  });

  useEffect(() => {
    localStorage.setItem("nts:mode", mode);
  }, [mode]);

  const modeDesc = useMemo(() => {
    if (mode === "easy") return "Big, recognizable subs. Great warm-up.";
    if (mode === "medium") return "A mix of popular and niche. Balanced.";
    return "Anything goes. Expect curveballs.";
  }, [mode]);

  return (
    <div style={styles.page}>
      <div style={styles.bgGlow} />

      {/* This wrapper centers when possible, but still scrolls on small screens */}
      <div style={styles.viewport}>
        <div style={styles.card}>
          <div style={styles.titleRow}>
            <div style={styles.redditDot} />
            <h1 style={styles.h1}>Name That Sub</h1>
          </div>

          <div style={styles.subtitle}>
            Guess the subreddit from a real Reddit comment.
            <br />
            New puzzle every day.
          </div>

          <div style={styles.modeGroup} aria-label="Choose difficulty">
            {(["easy", "medium", "hard"] as GameMode[]).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={active ? styles.modePillActive : styles.modePill}
                  aria-label={`${m} mode`}
                >
                  {m.toUpperCase()}
                </button>
              );
            })}
          </div>

          <div style={styles.modeHint}>
            <div style={styles.modeHintTitle}>
              Mode: <span style={styles.mono}>{mode.toUpperCase()}</span>
            </div>
            <div style={{ opacity: 0.88, lineHeight: 1.35 }}>{modeDesc}</div>
          </div>

          <div style={styles.pillRow}>
            <div style={styles.pill}>Daily puzzle</div>
            <div style={styles.pill}>Three clues</div>
            <div style={styles.pill}>Streaks & points</div>
          </div>

          {/* Big CTA */}
          <a href="./game.html" style={{ textDecoration: "none" }}>
            <button style={styles.startBtn}>Tap to Start</button>
          </a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    // Important: allow scrolling in Reddit mobile webview if needed
    overflowY: "auto",
    overflowX: "hidden",
    background:
      "radial-gradient(1200px 520px at 18% 10%, rgba(255,69,0,0.22), transparent 60%)," +
      "radial-gradient(900px 520px at 86% 0%, rgba(106,92,255,0.18), transparent 55%)," +
      "linear-gradient(180deg, #0b0f1a 0%, #070a12 55%, #05070d 100%)",
    color: "white",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
    position: "relative",
  },

  bgGlow: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "radial-gradient(650px 260px at 50% 0%, rgba(255,255,255,0.10), transparent 70%)",
  },

  viewport: {
    // Use modern viewport units to behave in mobile in-app browsers
    minHeight: "100svh",
    // fallback for older engines that don't support svh
    height: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    // Safe-area padding so button isn't under iPhone home bar
    paddingTop: "max(16px, env(safe-area-inset-top))",
    paddingRight: "max(16px, env(safe-area-inset-right))",
    paddingBottom: "max(24px, env(safe-area-inset-bottom))",
    paddingLeft: "max(16px, env(safe-area-inset-left))",

    // Extra: allow scrolling if content is taller than the viewport
    boxSizing: "border-box",
  },

  card: {
    width: "min(420px, 100%)",
    textAlign: "center",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 20,
    padding: "26px 18px",
    boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    position: "relative",
    zIndex: 1,
  },

  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  redditDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    background: "linear-gradient(180deg, #ff4500, #ff6a3d)",
    boxShadow: "0 0 0 4px rgba(255,69,0,0.16)",
  },
  h1: {
    margin: 0,
    fontSize: 32,
    fontWeight: 900,
    letterSpacing: -0.5,
    lineHeight: 1.1,
  },
  subtitle: {
    marginTop: 10,
    fontSize: 14,
    opacity: 0.86,
    lineHeight: 1.4,
  },

  mono: {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontWeight: 900,
  },

  modeGroup: {
    marginTop: 16,
    display: "flex",
    justifyContent: "center",
    gap: 8,
    padding: 6,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    flexWrap: "wrap",
  },
  modePill: {
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.18)",
    color: "rgba(255,255,255,0.9)",
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: 0.3,
    cursor: "pointer",
  },
  modePillActive: {
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background:
      "linear-gradient(180deg, rgba(255,69,0,0.95), rgba(255,69,0,0.65))",
    color: "white",
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: 0.3,
    cursor: "pointer",
  },

  modeHint: {
    marginTop: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.10)",
    textAlign: "center",
  },
  modeHintTitle: {
    fontSize: 12,
    fontWeight: 900,
    opacity: 0.9,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 6,
  },

  pillRow: {
    marginTop: 14,
    display: "flex",
    justifyContent: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  pill: {
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.14)",
    opacity: 0.95,
  },

  startBtn: {
    marginTop: 18,
    width: "100%",
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background:
      "linear-gradient(180deg, rgba(255,69,0,0.95), rgba(255,69,0,0.75))",
    color: "white",
    fontWeight: 900,
    fontSize: 15,
    cursor: "pointer",
  },

  footer: {
    marginTop: 14,
    fontSize: 12,
    opacity: 0.72,
    lineHeight: 1.35,
  },
};

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element in splash.html");
createRoot(rootEl).render(<SplashApp />);
