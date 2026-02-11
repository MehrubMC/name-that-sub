// src/server/routes/api.ts
import { Hono } from "hono";
import { context, redis, reddit } from "@devvit/web/server";

import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
} from "../../shared/api";

import { game } from "./game";

type ErrorResponse = {
  status: "error";
  message: string;
};

export const api = new Hono();

// --------------------
// Template counter endpoints (unchanged)
// --------------------
api.get("/init", async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error("API Init Error: postId not found in devvit context");
    return c.json<ErrorResponse>(
      {
        status: "error",
        message: "postId is required but missing from context",
      },
      400
    );
  }

  try {
    const [count, username] = await Promise.all([
      redis.get("count"),
      reddit.getCurrentUsername(),
    ]);

    return c.json<InitResponse>({
      type: "init",
      postId: postId,
      count: count ? parseInt(count, 10) : 0,
      username: username ?? "anonymous",
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = "Unknown error during initialization";
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>({ status: "error", message: errorMessage }, 400);
  }
});

api.post("/increment", async (c) => {
  const { postId } = context;

  if (!postId) {
    return c.json<ErrorResponse>(
      { status: "error", message: "postId is required" },
      400
    );
  }

  const count = await redis.incrBy("count", 1);

  return c.json<IncrementResponse>({
    type: "increment",
    postId,
    count,
  });
});

api.post("/decrement", async (c) => {
  const { postId } = context;

  if (!postId) {
    return c.json<ErrorResponse>(
      { status: "error", message: "postId is required" },
      400
    );
  }

  const count = await redis.incrBy("count", -1);

  return c.json<DecrementResponse>({
    type: "decrement",
    postId,
    count,
  });
});

// --------------------
// Mount your game API under /api/game/*
// --------------------
api.route("/game", game);
