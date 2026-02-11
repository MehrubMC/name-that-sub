// src/client/game.tsx
import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useState } from "react";
import {
  apiGetState,
  apiGuess,
  apiLockMode,
  apiGiveUp,
  type GetStateResponse,
  type GameMode,
} from "../shared/api";

type Stage = 1 | 2 | 3;

function normalizeInput(v: string) {
  let s = v.trim();
  if (s.toLowerCase().startsWith("/r/")) s = s.slice(3);
  if (s.toLowerCase().startsWith("r/")) s = s.slice(2);
  return s;
}

function utcTomorrowKey() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCUTCDate?.() ?? d.getUTCDate()).padStart(2, "0"); // safety
  return `${y}-${m}-${day}`;
}

function Modal({
  open,
  title,
  body,
  onClose,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          <button onClick={onClose} style={styles.iconBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div
          style={{
            marginTop: 10,
            color: "rgba(255,255,255,0.85)",
            lineHeight: 1.4,
          }}
        >
          {body}
        </div>

        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
          }}
        >
          <button onClick={onClose} style={styles.primaryBtn}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function GameApp() {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<GetStateResponse | null>(null);

  const [stage, setStage] = useState<Stage>(1);
  const [guess, setGuess] = useState("");

  const [toast, setToast] = useState<string | null>(null);
  const [revealedAnswer, setRevealedAnswer] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalBody, setModalBody] = useState<React.ReactNode>(null);

  // MODE
  const [mode, setMode] = useState<GameMode>(() => {
    const saved = localStorage.getItem("nts:mode");
    return saved === "easy" || saved === "medium" || saved === "hard"
      ? saved
      : "medium";
  });

  useEffect(() => {
    localStorage.setItem("nts:mode", mode);
  }, [mode]);

  function openAlreadyPlayedModal(m: GameMode) {
    const tomorrow = utcTomorrowKey();
    setModalTitle("Already played");
    setModalBody(
      <div>
        <div style={{ marginBottom: 10 }}>
          You already played <span style={{ fontWeight: 900 }}>{m.toUpperCase()}</span>{" "}
          today. Come back tomorrow for a new puzzle.
        </div>
        <div style={styles.callout}>
          Next puzzle available{" "}
          <span style={{ opacity: 0.9 }}>(UTC: {tomorrow})</span>.
        </div>
      </div>
    );
    setModalOpen(true);
  }

  useEffect(() => {
    (async () => {
      try {
        const s = await apiGetState(mode);
        setState(s);

        // if they load into a completed mode, tell them
        if (s.completedToday) {
          setToast(`You already played ${mode.toUpperCase()} today.`);
        }
      } catch (e: any) {
        setToast(e?.message ?? "Failed to load game.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const puzzle = state?.puzzle;

  const stageLabel = useMemo(() => {
    if (stage === 1) return "Clue 1 · Comment only · 100 pts";
    if (stage === 2) return "Clue 2 · + Post body · 60 pts";
    return "Clue 3 · + Title · 30 pts";
  }, [stage]);

  async function lockIfNeeded() {
    if (!state) return;
    if (state.modeIsLocked) return;
    try {
      const res = await apiLockMode(mode);
      setState((prev) =>
        prev
          ? {
              ...prev,
              modeIsLocked: true,
              modeLocked: res.modeLocked ?? prev.modeLocked,
              completedToday: res.completedToday ?? prev.completedToday,
            }
          : prev
      );
    } catch {
      // ignore
    }
  }

  async function nextClue() {
    setToast(null);
    if (state?.completedToday) {
      openAlreadyPlayedModal(mode);
      return;
    }
    if (stage === 1) await lockIfNeeded();
    setStage((s) => (s === 1 ? 2 : s === 2 ? 3 : 3));
  }

  function openComeBackModal(kind: "win" | "giveup", answer: string) {
    const tomorrow = utcTomorrowKey();
    setModalTitle(kind === "win" ? "Nice!" : "All good!");
    setModalBody(
      <div>
        <div style={{ marginBottom: 10 }}>
          {kind === "win" ? "You got it." : "Better luck next time."} The answer
          was <span style={{ fontWeight: 800 }}>r/{answer}</span>.
        </div>
        <div style={styles.callout}>
          Come back tomorrow for the next puzzle{" "}
          <span style={{ opacity: 0.9 }}>(UTC: {tomorrow})</span>.
        </div>
      </div>
    );
    setModalOpen(true);
  }

  async function submitGuess() {
    if (!puzzle) return;
    if (state?.completedToday) {
      openAlreadyPlayedModal(mode);
      return;
    }

    const cleaned = normalizeInput(guess);
    if (!cleaned) return;

    setSubmitting(true);
    setToast(null);

    try {
      const res = await apiGuess(cleaned, stage, mode);

      // keep state consistent immediately
      setState((prev) =>
        prev
          ? {
              ...prev,
              modeIsLocked: true,
              modeLocked: res.modeLocked ?? prev.modeLocked,
              completedToday: res.completedToday ?? prev.completedToday,
              totalScore: res.totalScore ?? prev.totalScore,
              streak: res.streak ?? prev.streak,
            }
          : prev
      );

      if (res.correct) {
        setRevealedAnswer(res.answer);
        setToast(
          `✅ Correct! +${res.pointsAwarded} pts · Streak ${res.streak} · Total ${res.totalScore}`
        );
        openComeBackModal("win", res.answer);
      } else {
        if (stage < 3) setToast("❌ Not quite. Reveal the next clue or try again.");
        else {
          setRevealedAnswer(res.answer);
          setToast(`❌ Nope. Answer: r/${res.answer}`);
          openComeBackModal("giveup", res.answer);
        }
      }

      // refresh state for the current mode
      const s = await apiGetState(mode);
      setState(s);
    } catch (e: any) {
      setToast(e?.message ?? "Failed to submit guess.");
    } finally {
      setSubmitting(false);
    }
  }

  async function giveUp() {
    if (!puzzle) return;

    if (state?.completedToday) {
      openAlreadyPlayedModal(mode);
      return;
    }

    setSubmitting(true);
    setToast(null);

    try {
      const res = await apiGiveUp(mode);

      setStage(3);
      setRevealedAnswer(res.answer);

      setState((prev) =>
        prev
          ? {
              ...prev,
              modeLocked: res.modeLocked ?? prev.modeLocked,
              modeIsLocked: true,
              completedToday: true,
            }
          : prev
      );

      setToast(`Answer: r/${res.answer}`);
      openComeBackModal("giveup", res.answer);

      const s = await apiGetState(mode);
      setState(s);
    } catch (e: any) {
      setToast(e?.message ?? "Failed to give up.");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  async function switchMode(m: GameMode) {
    if (submitting) return;

    setMode(m);
    setLoading(true);
    setToast(null);

    try {
      const s = await apiGetState(m);
      setState(s);

      // reset per-mode UI
      setStage(1);
      setGuess("");
      setRevealedAnswer(null);

      // IMPORTANT: show popup if they already played this mode
      if (s.completedToday) {
        setToast(`You already played ${m.toUpperCase()} today.`);
        openAlreadyPlayedModal(m);
      }
    } catch (e: any) {
      setToast(e?.message ?? "Failed to switch mode.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.pageFixed}>
        <div style={styles.centerWrap}>
          <div style={styles.glassCard}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              Loading today’s puzzle…
            </div>
            <div style={{ marginTop: 10, opacity: 0.75 }}>
              Fetching a cursed comment from Reddit.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!state || !puzzle) {
    return (
      <div style={styles.pageFixed}>
        <div style={styles.centerWrap}>
          <div style={styles.glassCard}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              Couldn’t load today’s puzzle
            </div>
            <div style={{ marginTop: 10, opacity: 0.8 }}>
              {toast ?? "Try refreshing."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const completed = !!state.completedToday;
  const disabled = submitting || !!revealedAnswer || completed;

  return (
    <div style={styles.pageFixed}>
      <div style={styles.topGlow} />

      <div style={styles.shell}>
        <header style={styles.header}>
          <div>
            <div style={styles.titleRow}>
              <div style={styles.redditDot} />
              <h1 style={styles.h1}>Name That Sub</h1>
            </div>
            <div style={styles.subhead}>
              Daily <span style={styles.mono}>{puzzle.dateKey}</span> · Score{" "}
              <span style={styles.mono}>{state.totalScore}</span> · Streak{" "}
              <span style={styles.mono}>{state.streak}</span>
              {" · "}Mode <span style={styles.mono}>{mode.toUpperCase()}</span>
            </div>

            {completed && (
              <div style={{ marginTop: 8 }}>
                <div style={styles.completedBanner}>
                  You already played this mode today — come back tomorrow.
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={styles.modeGroup}>
              {(["easy", "medium", "hard"] as GameMode[]).map((m) => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    onClick={() => switchMode(m)}
                    style={active ? styles.modePillActive : styles.modePill}
                    disabled={submitting}
                  >
                    {m.toUpperCase()}
                  </button>
                );
              })}
            </div>

            <div style={styles.badge}>r/…</div>
          </div>
        </header>

        <div style={styles.scrollArea}>
          <div style={styles.wrap}>
            <section style={styles.glassCard}>
              <div style={styles.cardTopRow}>
                <div style={styles.pill}>{stageLabel}</div>
                <div style={{ opacity: 0.65, fontSize: 12 }}>
                  Tip: Guess earlier for more points.
                </div>
              </div>

              <div style={styles.block}>
                <div style={styles.blockLabel}>Comment</div>
                <div style={styles.textBlock}>{puzzle.commentBody}</div>
              </div>

              {stage >= 2 && (
                <div style={styles.block}>
                  <div style={styles.blockLabel}>Post body</div>
                  <div style={styles.textBlock}>
                    {puzzle.postBody?.trim() ? (
                      puzzle.postBody
                    ) : (
                      <i style={{ opacity: 0.8 }}>(No body — title-only post)</i>
                    )}
                  </div>
                </div>
              )}

              {stage >= 3 && (
                <div style={styles.block}>
                  <div style={styles.blockLabel}>Title</div>
                  <div style={styles.textBlock}>{puzzle.postTitle}</div>
                </div>
              )}
            </section>

            <section style={styles.controlsSticky}>
              <div style={styles.controlsInner}>
                <div style={styles.inputRow}>
                  <div style={styles.inputPrefix}>r/</div>
                  <input
                    value={guess}
                    onChange={(e) => setGuess(e.target.value)}
                    placeholder="Type the subreddit name… (e.g. AskReddit)"
                    style={styles.input}
                    disabled={disabled}
                    onKeyDown={(e) => e.key === "Enter" && submitGuess()}
                  />
                  <button
                    onClick={submitGuess}
                    disabled={disabled || !guess.trim()}
                    style={styles.primaryBtn}
                  >
                    Guess
                  </button>
                </div>

                <div style={styles.btnRow}>
                  <button
                    onClick={nextClue}
                    disabled={disabled || stage === 3}
                    style={styles.secondaryBtn}
                  >
                    Reveal next clue
                  </button>
                  <button
                    onClick={giveUp}
                    disabled={disabled}
                    style={styles.ghostBtn}
                  >
                    Give up
                  </button>
                </div>
              </div>
            </section>

            <footer style={styles.footer}>
              <div style={{ opacity: 0.75 }}>
                Make it a daily habit. Drop a comment with what clue you got it on
                👀
              </div>
            </footer>

            <div style={{ height: 18 }} />
          </div>
        </div>
      </div>

      {toast && (
        <div style={styles.toast}>
          <div style={styles.toastInner}>{toast}</div>
        </div>
      )}

      <Modal
        open={modalOpen}
        title={modalTitle}
        body={modalBody}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}

// ----- Styles -----
const styles: Record<string, React.CSSProperties> = {
  pageFixed: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    background:
      "radial-gradient(1200px 500px at 20% 10%, rgba(255,69,0,0.22), transparent 60%)," +
      "radial-gradient(900px 500px at 85% 0%, rgba(106,92,255,0.18), transparent 55%)," +
      "linear-gradient(180deg, #0b0f1a 0%, #070a12 55%, #05070d 100%)",
    color: "white",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
  },
  topGlow: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "radial-gradient(600px 240px at 50% 0%, rgba(255,255,255,0.10), transparent 70%)",
  },
  shell: {
    position: "relative",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    paddingTop: "max(14px, env(safe-area-inset-top))",
  },
  scrollArea: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    WebkitOverflowScrolling: "touch",
    touchAction: "pan-y",
  },
  wrap: {
    maxWidth: 920,
    margin: "0 auto",
    paddingRight: "max(16px, env(safe-area-inset-right))",
    paddingLeft: "max(16px, env(safe-area-inset-left))",
    paddingBottom: "max(16px, env(safe-area-inset-bottom))",
    boxSizing: "border-box",
  },
  centerWrap: {
    maxWidth: 720,
    margin: "0 auto",
    padding: 24,
  },

  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    padding:
      "0 max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left))",
    flexWrap: "wrap",
  },
  titleRow: { display: "flex", alignItems: "center", gap: 10 },
  redditDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    background: "linear-gradient(180deg, #ff4500, #ff6a3d)",
    boxShadow: "0 0 0 4px rgba(255,69,0,0.16)",
    marginTop: 10,
  },
  h1: { margin: 0, fontSize: 30, letterSpacing: -0.4, fontWeight: 900 },
  subhead: { marginTop: 6, opacity: 0.85, fontSize: 13 },
  mono: {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontWeight: 700,
  },

  completedBanner: {
    display: "inline-block",
    padding: "8px 10px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.14)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.95,
  },

  badge: {
    padding: "8px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.14)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    fontWeight: 800,
    letterSpacing: 0.2,
    userSelect: "none",
  },

  glassCard: {
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
  },

  cardTopRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.12)",
    fontSize: 12,
    fontWeight: 800,
  },

  block: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.10)",
  },
  blockLabel: {
    fontSize: 12,
    opacity: 0.75,
    fontWeight: 800,
    letterSpacing: 0.4,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  textBlock: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
    fontSize: 14,
    color: "rgba(255,255,255,0.92)",
    wordBreak: "break-word",
  },

  controlsSticky: {
    position: "sticky",
    bottom: 0,
    marginTop: 14,
    paddingBottom: "max(10px, env(safe-area-inset-bottom))",
  },
  controlsInner: {
    padding: 14,
    borderRadius: 18,
    background: "rgba(12,14,22,0.78)",
    border: "1px solid rgba(255,255,255,0.12)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    boxShadow: "0 -10px 40px rgba(0,0,0,0.35)",
  },

  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  inputPrefix: {
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.12)",
    fontWeight: 900,
    opacity: 0.9,
  },
  input: {
    flex: "1 1 220px",
    minWidth: 180,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(0,0,0,0.25)",
    color: "white",
    outline: "none",
    fontSize: 14,
  },

  btnRow: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" },
  primaryBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background:
      "linear-gradient(180deg, rgba(255,69,0,0.95), rgba(255,69,0,0.75))",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
  },
  secondaryBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.08)",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
  },
  ghostBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "rgba(255,255,255,0.9)",
    fontWeight: 800,
    cursor: "pointer",
  },

  footer: { marginTop: 14, fontSize: 12, opacity: 0.75, padding: "0 6px 8px" },

  toast: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: "max(18px, env(safe-area-inset-bottom))",
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    zIndex: 50,
  },
  toastInner: {
    maxWidth: 720,
    margin: "0 14px",
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(0,0,0,0.55)",
    border: "1px solid rgba(255,255,255,0.14)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 700,
    boxShadow: "0 14px 40px rgba(0,0,0,0.35)",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
    zIndex: 100,
  },
  modalCard: {
    width: "min(520px, 100%)",
    borderRadius: 18,
    padding: 16,
    background: "rgba(20,24,36,0.78)",
    border: "1px solid rgba(255,255,255,0.16)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "white",
    cursor: "pointer",
    fontWeight: 900,
  },
  callout: {
    padding: 12,
    borderRadius: 14,
    background: "rgba(255,69,0,0.16)",
    border: "1px solid rgba(255,69,0,0.28)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 700,
  },

  modeGroup: {
    display: "flex",
    padding: 6,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    gap: 6,
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
};

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element in game.html");
createRoot(rootEl).render(<GameApp />);
