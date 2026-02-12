// src/server/routes/game.ts
import { Hono } from "hono";
import { redis, reddit } from "@devvit/web/server";
import type { DailyPuzzle, GameMode, GetStateResponse, GuessResponse } from "../../shared/api";

function utcDateKey(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcDateKeyOffset(daysOffset: number): string {
  return utcDateKey(new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000));
}

function normalizeGuess(input: string): string {
  const s = input.trim().replace(/^\/?r\//i, "");
  return s.replace(/[^A-Za-z0-9_]/g, "");
}

function normalizeMode(raw: unknown): GameMode {
  const s = String(raw ?? "").toLowerCase();
  if (s === "easy" || s === "medium" || s === "hard") return s;
  return "medium";
}

/**
 * We accept a client-provided YYYY-MM-DD dateKey so "daily" aligns to the user's local day.
 * To avoid abuse (jumping far into the future/past), we only accept keys within +/- 1 day of UTC "today".
 */
function normalizeClientDateKey(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return utcDateKey();
  return s;
}

function resolveDateKey(queryOrBodyDateKey: unknown): string {
  const dk = normalizeClientDateKey(queryOrBodyDateKey);

  const allowed = new Set([utcDateKeyOffset(-1), utcDateKeyOffset(0), utcDateKeyOffset(1)]);
  // If the client key is outside the safe window, fall back to UTC today.
  if (!allowed.has(dk)) return utcDateKey();
  return dk;
}

function seedFromString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickIndex(len: number, seed: number): number {
  let x = seed || 123456789;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return Math.abs(x) % len;
}

function minSubsForMode(mode: GameMode): number {
  if (mode === "easy") return 1_000_000;
  if (mode === "medium") return 10_000;
  return 0;
}

function getSubscriberCount(info: any): number {
  const candidates = [
    info?.subscribers,
    info?.subscriberCount,
    info?.subscriber_count,
    info?.subscribersCount,
    info?.communitySize,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function isNsfwSub(info: any): boolean {
  const candidates = [info?.nsfw, info?.isNsfw, info?.over18, info?.isOver18, info?.over_18];
  return candidates.some((v) => v === true);
}

function getPostSubredditName(post: any): string | null {
  return post?.subredditName ?? post?.subreddit?.name ?? post?.subreddit ?? null;
}

// ------------------------------
// Per-mode key helpers
// ------------------------------
function kScore(userId: string, mode: GameMode) {
  return `nts:user:${userId}:${mode}:score`;
}
function kStreak(userId: string, mode: GameMode) {
  return `nts:user:${userId}:${mode}:streak`;
}
function kLastDate(userId: string, mode: GameMode) {
  return `nts:user:${userId}:${mode}:lastDate`;
}
function kPlayed(userId: string, mode: GameMode, dateKey: string) {
  return `nts:user:${userId}:${mode}:played:${dateKey}`; // points awarded once/day/mode (on win)
}
function kCommit(userId: string, mode: GameMode, dateKey: string) {
  return `nts:user:${userId}:${mode}:commit:${dateKey}`; // lock after first reveal or guess
}
function kCompleted(userId: string, mode: GameMode, dateKey: string) {
  return `nts:user:${userId}:${mode}:completed:${dateKey}`; // finished (win OR final loss OR give up)
}

async function readCommitted(userId: string, mode: GameMode, dateKey: string): Promise<boolean> {
  return (await redis.get(kCommit(userId, mode, dateKey))) === "1";
}

async function commitMode(userId: string, mode: GameMode, dateKey: string): Promise<void> {
  const key = kCommit(userId, mode, dateKey);
  await redis.set(key, "1");
  await redis.expire(key, 60 * 60 * 48);
}

async function readCompleted(userId: string, mode: GameMode, dateKey: string): Promise<boolean> {
  return (await redis.get(kCompleted(userId, mode, dateKey))) === "1";
}

async function setCompleted(userId: string, mode: GameMode, dateKey: string): Promise<void> {
  const key = kCompleted(userId, mode, dateKey);
  await redis.set(key, "1");
  await redis.expire(key, 60 * 60 * 48);
}

// -------- subreddit selection (API-driven, no allowlist) --------
async function pickSubredditForMode(dateKey: string, mode: GameMode): Promise<string> {
  const minSubs = minSubsForMode(mode);

  let posts: any[] = [];
  try {
    posts = await reddit.getNewPosts({ subredditName: "all", limit: 120, pageSize: 120 }).all();
  } catch {
    posts = await reddit.getHotPosts({ subredditName: "all", limit: 120, pageSize: 120 }).all();
  }

  const candidates = posts
    .map((p) => ({ post: p, sub: getPostSubredditName(p) }))
    .filter((x) => !!x.sub) as { post: any; sub: string }[];

  if (candidates.length === 0) return "all";

  // mode is part of seed so easy/medium/hard pick different subs
  const baseSeed = seedFromString(`${dateKey}:${mode}:subpick`);
  const tried = new Set<string>();

  for (let i = 0; i < Math.min(45, candidates.length); i++) {
    const idx = pickIndex(candidates.length, seedFromString(`${baseSeed}:${i}`));
    const sub = candidates[idx]!.sub;
    if (tried.has(sub)) continue;
    tried.add(sub);

    try {
      const info = await reddit.getSubredditInfoByName(sub);
      if (isNsfwSub(info)) continue;

      const subs = getSubscriberCount(info);

      // lenient if subscriber count unknown
      if (subs === 0 || subs >= minSubs) return sub;
    } catch {
      continue;
    }
  }

  return candidates[pickIndex(candidates.length, baseSeed)]!.sub;
}

async function buildDailyPuzzle(dateKey: string, mode: GameMode): Promise<DailyPuzzle> {
  const cacheKey = `nts:puzzle:${dateKey}:${mode}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as DailyPuzzle;

  const subreddit = await pickSubredditForMode(dateKey, mode);

  let posts: any[] = [];
  try {
    posts = await reddit.getNewPosts({ subredditName: subreddit, limit: 50, pageSize: 50 }).all();
  } catch {
    posts = await reddit.getHotPosts({ subredditName: subreddit, limit: 50, pageSize: 50 }).all();
  }

  if (posts.length === 0) throw new Error(`No posts found for r/${subreddit}`);

  const post = posts[pickIndex(posts.length, seedFromString(`${dateKey}:${mode}:${subreddit}:post`))];

  const postId: string = post.id;
  const postTitle: string = post.title ?? "";
  const postBody: string = (post.selftext ?? post.body ?? "").toString();

  const comments = await reddit
    .getComments({ postId: postId as `t3_${string}`, limit: 200, pageSize: 100 })
    .all();

  const usable = comments
    .map((c: any) => ({ id: c.id as string, body: (c.body ?? "").toString().trim() }))
    .filter((c: any) => {
      if (!c.body) return false;
      if (c.body === "[deleted]" || c.body === "[removed]") return false;
      if (c.body.length < 25) return false;

      const lower = c.body.toLowerCase();
      if (lower.includes(`r/${subreddit.toLowerCase()}`)) return false;
      if (lower.includes("this sub") || lower.includes("this subreddit")) return false;
      if (lower.includes("i am a bot") || lower.includes("automod")) return false;
      return true;
    });

  const pool = usable.length
    ? usable.slice(0, 60)
    : comments
        .map((c: any) => ({ id: c.id as string, body: (c.body ?? "").toString().trim() }))
        .filter((c: any) => c.body && c.body !== "[deleted]" && c.body !== "[removed]")
        .slice(0, 60);

  if (pool.length === 0) throw new Error(`No usable comments for post ${postId}`);

  const comment = pool[pickIndex(pool.length, seedFromString(`${dateKey}:${mode}:${subreddit}:comment`))];

  const puzzle: DailyPuzzle = {
    dateKey,
    mode,
    subreddit,
    postId,
    postTitle,
    postBody,
    commentId: comment.id,
    commentBody: comment.body,
  };

  await redis.set(cacheKey, JSON.stringify(puzzle));
  await redis.expire(cacheKey, 60 * 60 * 48);
  return puzzle;
}

export const game = new Hono();

// GET /api/game/state?mode=...&dateKey=...
game.get("/state", async (c) => {
  const requestedMode = normalizeMode(c.req.query("mode"));
  const dateKey = resolveDateKey(c.req.query("dateKey"));

  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  const modeIsLocked = await readCommitted(userId, requestedMode, dateKey);
  const completedToday = await readCompleted(userId, requestedMode, dateKey);

  const puzzle = await buildDailyPuzzle(dateKey, requestedMode);

  const totalScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
  const streak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);
  const lastPlayedDateKey = (await redis.get(kLastDate(userId, requestedMode))) ?? undefined;

  const payload: GetStateResponse = {
    puzzle,
    modeLocked: requestedMode,
    modeIsLocked,
    completedToday,
    totalScore,
    streak,
    lastPlayedDateKey,
  };

  return c.json(payload);
});

// POST /api/game/lock  body: { mode, dateKey }
game.post("/lock", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const requestedMode = normalizeMode(body.mode);
  const dateKey = resolveDateKey(body.dateKey);

  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  if (!(await readCommitted(userId, requestedMode, dateKey))) {
    await commitMode(userId, requestedMode, dateKey);
  }

  const completedToday = await readCompleted(userId, requestedMode, dateKey);

  return c.json({ modeLocked: requestedMode, modeIsLocked: true, completedToday });
});

// POST /api/game/giveup  body: { mode, dateKey }
game.post("/giveup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const requestedMode = normalizeMode(body.mode);
  const dateKey = resolveDateKey(body.dateKey);

  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  if (!(await readCommitted(userId, requestedMode, dateKey))) {
    await commitMode(userId, requestedMode, dateKey);
  }

  if (!(await readCompleted(userId, requestedMode, dateKey))) {
    await setCompleted(userId, requestedMode, dateKey);
  }

  const puzzle = await buildDailyPuzzle(dateKey, requestedMode);

  return c.json({
    modeLocked: requestedMode,
    modeIsLocked: true,
    completedToday: true,
    answer: puzzle.subreddit,
  });
});

// POST /api/game/guess  body: { subredditGuess, stageUsed, mode, dateKey }
game.post("/guess", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;

  const subredditGuess: string = String(body.subredditGuess ?? "");
  const stageUsed: 1 | 2 | 3 = body.stageUsed ?? 3;
  const requestedMode = normalizeMode(body.mode);
  const dateKey = resolveDateKey(body.dateKey);

  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  // lock after first guess
  if (!(await readCommitted(userId, requestedMode, dateKey))) {
    await commitMode(userId, requestedMode, dateKey);
  }

  const puzzle = await buildDailyPuzzle(dateKey, requestedMode);

  const guess = normalizeGuess(subredditGuess);
  const answer = puzzle.subreddit;
  const correct = guess.toLowerCase() === answer.toLowerCase();

  const alreadyCompleted = await readCompleted(userId, requestedMode, dateKey);

  // final loss ends the mode too
  const isFinalLoss = !correct && stageUsed === 3;
  const finishesNow = correct || isFinalLoss;

  // award only once/day/mode, only on win
  const playedKey = kPlayed(userId, requestedMode, dateKey);
  const alreadyAwarded = (await redis.get(playedKey)) === "1";

  let pointsAwarded = 0;

  if (!alreadyCompleted) {
    if (correct && !alreadyAwarded) {
      pointsAwarded = stageUsed === 1 ? 100 : stageUsed === 2 ? 60 : 30;

      await redis.set(playedKey, "1");
      await redis.expire(playedKey, 60 * 60 * 48);

      const prevScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
      await redis.set(kScore(userId, requestedMode), String(prevScore + pointsAwarded));

      // streak increments only on win
      const lastDate = (await redis.get(kLastDate(userId, requestedMode))) ?? "";
      const prevStreak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);

      // "yesterday" relative to the *dateKey* (string) is tricky on server.
      // We keep streak logic based on UTC day boundary for safety.
      // (Streak is still per-mode and consistent; daily puzzle boundary is client-local.)
      const yesterday = utcDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const newStreak = lastDate === yesterday ? prevStreak + 1 : 1;

      await redis.set(kStreak(userId, requestedMode), String(newStreak));
      await redis.set(kLastDate(userId, requestedMode), dateKey);
    }

    if (finishesNow) {
      await setCompleted(userId, requestedMode, dateKey);
    }
  }

  const totalScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
  const streak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);
  const completedToday = await readCompleted(userId, requestedMode, dateKey);

  const payload: GuessResponse = {
    correct,
    stageUsed,
    pointsAwarded: correct ? pointsAwarded : 0,
    answer,
    totalScore,
    streak,
    modeLocked: requestedMode,
    modeIsLocked: true,
    completedToday,
  };

  return c.json(payload);
});
