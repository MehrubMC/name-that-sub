// src/server/routes/game.ts
import { Hono } from "hono";
import { redis, reddit } from "@devvit/web/server";
import type {
  DailyPuzzle,
  GameMode,
  GetStateResponse,
  GuessResponse,
} from "../../shared/api";

function utcDateKey(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  const candidates = [
    info?.nsfw,
    info?.isNsfw,
    info?.over18,
    info?.isOver18,
    info?.over_18,
  ];
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
  return `nts:user:${userId}:${mode}:played:${dateKey}`;
}
// Commit lock is per-mode now. It just means "you committed on this mode today".
function kCommit(userId: string, mode: GameMode, dateKey: string) {
  return `nts:user:${userId}:${mode}:commit:${dateKey}`;
}

// -------- per-mode commit storage --------
async function readCommitted(
  userId: string,
  mode: GameMode,
  dateKey: string
): Promise<boolean> {
  return (await redis.get(kCommit(userId, mode, dateKey))) === "1";
}

async function commitMode(
  userId: string,
  mode: GameMode,
  dateKey: string
): Promise<void> {
  const key = kCommit(userId, mode, dateKey);
  await redis.set(key, "1");
  await redis.expire(key, 60 * 60 * 48);
}

// ------------------------------
// Deterministic shuffle + safe info fetch
// ------------------------------
function shuffleDeterministic<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let x = seed || 123456789;
  for (let i = a.length - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    const j = Math.abs(x) % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function safeSubInfo(name: string): Promise<any | null> {
  try {
    return await reddit.getSubredditInfoByName(name);
  } catch {
    return null;
  }
}

// -------- subreddit selection (API-driven, no allowlist) --------
// Fixes "medium == hard" by NOT treating unknown subscriber counts as qualifying for medium/easy.
async function pickSubredditForMode(dateKey: string, mode: GameMode): Promise<string> {
  const minSubs = minSubsForMode(mode);

  let posts: any[] = [];
  try {
    posts = await reddit
      .getNewPosts({ subredditName: "all", limit: 150, pageSize: 150 })
      .all();
  } catch {
    posts = await reddit
      .getHotPosts({ subredditName: "all", limit: 150, pageSize: 150 })
      .all();
  }

  const rawSubs = posts
    .map((p) => getPostSubredditName(p))
    .filter((s): s is string => !!s);

  const uniqueSubs = Array.from(new Set(rawSubs));
  if (uniqueSubs.length === 0) return "all";

  // Deterministic scan order per (date, mode) so each mode tends to diverge.
  const scanSeed = seedFromString(`${dateKey}:${mode}:scan`);
  const subsToScan = shuffleDeterministic(uniqueSubs, scanSeed);

  // HARD: anything (still prefer non-NSFW when info is available)
  if (mode === "hard") {
    for (let i = 0; i < Math.min(40, subsToScan.length); i++) {
      const sub = subsToScan[i]!;
      const info = await safeSubInfo(sub);
      if (!info) continue;
      if (isNsfwSub(info)) continue;
      return sub;
    }
    // fallback if info lookups fail
    return subsToScan[pickIndex(subsToScan.length, scanSeed)]!;
  }

  // EASY/MEDIUM: require a *known* subscriber count to qualify (subs > 0)
  const qualifying: { sub: string; subs: number }[] = [];
  const unknownButSafe: string[] = [];

  for (let i = 0; i < Math.min(60, subsToScan.length); i++) {
    const sub = subsToScan[i]!;
    const info = await safeSubInfo(sub);
    if (!info) continue;
    if (isNsfwSub(info)) continue;

    const subs = getSubscriberCount(info);

    if (subs > 0) {
      if (subs >= minSubs) qualifying.push({ sub, subs });
    } else {
      unknownButSafe.push(sub);
    }

    if (qualifying.length >= 12) break;
  }

  if (qualifying.length > 0) {
    // OPTIONAL: make easy a bit easier by biasing to bigger subs (still API-driven, no hardcoding)
    const bucket =
      mode === "easy"
        ? qualifying.sort((a, b) => b.subs - a.subs).slice(0, 12)
        : qualifying;

    const pickSeed = seedFromString(`${dateKey}:${mode}:pickQualified`);
    return bucket[pickIndex(bucket.length, pickSeed)]!.sub;
  }

  // Fallback so we never get stuck
  if (unknownButSafe.length > 0) {
    const pickSeed = seedFromString(`${dateKey}:${mode}:pickUnknown`);
    return unknownButSafe[pickIndex(unknownButSafe.length, pickSeed)]!;
  }

  return subsToScan[pickIndex(subsToScan.length, scanSeed)]!;
}

async function buildDailyPuzzle(
  dateKey: string,
  mode: GameMode
): Promise<DailyPuzzle> {
  const cacheKey = `nts:puzzle:${dateKey}:${mode}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as DailyPuzzle;

  const subreddit = await pickSubredditForMode(dateKey, mode);

  let posts: any[] = [];
  try {
    posts = await reddit
      .getNewPosts({ subredditName: subreddit, limit: 50, pageSize: 50 })
      .all();
  } catch {
    posts = await reddit
      .getHotPosts({ subredditName: subreddit, limit: 50, pageSize: 50 })
      .all();
  }

  if (posts.length === 0) throw new Error(`No posts found for r/${subreddit}`);

  const post =
    posts[pickIndex(posts.length, seedFromString(`${dateKey}:${mode}:${subreddit}:post`))];

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

  const comment =
    pool[pickIndex(pool.length, seedFromString(`${dateKey}:${mode}:${subreddit}:comment`))];

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

// GET /api/game/state?mode=...
// IMPORTANT: do NOT commit/lock here.
game.get("/state", async (c) => {
  const requestedMode = normalizeMode(c.req.query("mode"));
  const dateKey = utcDateKey();

  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  const modeIsLocked = await readCommitted(userId, requestedMode, dateKey);
  const puzzle = await buildDailyPuzzle(dateKey, requestedMode);

  const totalScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
  const streak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);
  const lastPlayedDateKey =
    (await redis.get(kLastDate(userId, requestedMode))) ?? undefined;

  const payload: GetStateResponse = {
    puzzle,
    modeLocked: requestedMode,
    modeIsLocked,
    totalScore,
    streak,
    lastPlayedDateKey,
  };

  return c.json(payload);
});

// POST /api/game/lock  body: { mode }
// Called when user hits "Reveal next clue" for the FIRST time (stage 1 -> 2)
game.post("/lock", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const requestedMode = normalizeMode(body.mode);

  const dateKey = utcDateKey();
  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  const already = await readCommitted(userId, requestedMode, dateKey);
  if (!already) await commitMode(userId, requestedMode, dateKey);

  return c.json({ modeLocked: requestedMode, modeIsLocked: true });
});

// POST /api/game/guess  body: { subredditGuess, stageUsed, mode }
// Commits the mode if not committed already (first guess)
game.post("/guess", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;

  const subredditGuess: string = String(body.subredditGuess ?? "");
  const stageUsed: 1 | 2 | 3 = body.stageUsed ?? 3;
  const requestedMode = normalizeMode(body.mode);

  const dateKey = utcDateKey();
  const user = await reddit.getCurrentUser();
  const userId = user?.id ?? "anon";

  // Commit mode for this mode/day (so UI locks after first action)
  const alreadyCommitted = await readCommitted(userId, requestedMode, dateKey);
  if (!alreadyCommitted) await commitMode(userId, requestedMode, dateKey);

  const puzzle = await buildDailyPuzzle(dateKey, requestedMode);

  const guess = normalizeGuess(subredditGuess);
  const answer = puzzle.subreddit;
  const correct = guess.toLowerCase() === answer.toLowerCase();

  // Award points ONCE per day per mode
  const playedKey = kPlayed(userId, requestedMode, dateKey);
  const alreadyAwarded = (await redis.get(playedKey)) === "1";

  let pointsAwarded = 0;

  if (correct && !alreadyAwarded) {
    pointsAwarded = stageUsed === 1 ? 100 : stageUsed === 2 ? 60 : 30;

    await redis.set(playedKey, "1");
    await redis.expire(playedKey, 60 * 60 * 48);

    const prevScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
    await redis.set(kScore(userId, requestedMode), String(prevScore + pointsAwarded));

    // Streak is per-mode
    const lastDate = (await redis.get(kLastDate(userId, requestedMode))) ?? "";
    const prevStreak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);
    const yesterday = utcDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const newStreak = lastDate === yesterday ? prevStreak + 1 : 1;

    await redis.set(kStreak(userId, requestedMode), String(newStreak));
    await redis.set(kLastDate(userId, requestedMode), dateKey);
  }

  const totalScore = Number((await redis.get(kScore(userId, requestedMode))) ?? 0);
  const streak = Number((await redis.get(kStreak(userId, requestedMode))) ?? 0);

  const payload: GuessResponse = {
    correct,
    stageUsed,
    pointsAwarded: correct ? pointsAwarded : 0,
    answer,
    totalScore,
    streak,
    modeLocked: requestedMode,
    modeIsLocked: true,
  };

  return c.json(payload);
});
