// src/shared/api.ts

export type GameMode = "easy" | "medium" | "hard";

// --------------------
// Template counter API types (keeps routes/api.ts happy)
// --------------------
export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
};

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
};

// --------------------
// Game types
// --------------------
export type DailyPuzzle = {
  dateKey: string; // YYYY-MM-DD UTC
  mode: GameMode;

  subreddit: string;
  postId: string;
  postTitle: string;
  postBody: string;

  commentId: string;
  commentBody: string;
};

export type GetStateResponse = {
  puzzle: DailyPuzzle;

  modeLocked: GameMode; // current effective mode for puzzle shown
  modeIsLocked: boolean; // whether user has "committed" today (after first reveal or first guess)
  completedToday: boolean; // finished this mode today (win, stage-3 loss, or give up)

  totalScore: number;
  streak: number;
  lastPlayedDateKey?: string;
};

export type GuessResponse = {
  correct: boolean;
  stageUsed: 1 | 2 | 3;
  pointsAwarded: number;

  answer: string;
  totalScore: number;
  streak: number;

  modeLocked: GameMode;
  modeIsLocked: boolean;

  // NEW: lets client show modal immediately without waiting for refetch
  completedToday: boolean;
};

export type LockModeResponse = {
  modeLocked: GameMode;
  modeIsLocked: boolean;
  completedToday: boolean;
};

export type GiveUpResponse = {
  modeLocked: GameMode;
  modeIsLocked: boolean;
  completedToday: boolean;
  answer: string;
};

// --------------------
// Client fetch helpers
// --------------------
export async function apiGetState(mode: GameMode): Promise<GetStateResponse> {
  const res = await fetch(`/api/game/state?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error(`Failed /api/game/state: ${res.status}`);
  return res.json();
}

export async function apiGuess(
  subredditGuess: string,
  stageUsed: 1 | 2 | 3,
  mode: GameMode
): Promise<GuessResponse> {
  const res = await fetch("/api/game/guess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subredditGuess, stageUsed, mode }),
  });
  if (!res.ok) throw new Error(`Failed /api/game/guess: ${res.status}`);
  return res.json();
}

// lock mode when user reveals the 2nd clue (first reveal)
export async function apiLockMode(mode: GameMode): Promise<LockModeResponse> {
  const res = await fetch("/api/game/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`Failed /api/game/lock: ${res.status}`);
  return res.json();
}

export async function apiGiveUp(mode: GameMode): Promise<GiveUpResponse> {
  const res = await fetch("/api/game/giveup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`Failed /api/game/giveup: ${res.status}`);
  return res.json();
}
