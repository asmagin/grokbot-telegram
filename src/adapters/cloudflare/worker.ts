import { botsHealth, loadBots, selectBot } from "../../core/bots.js";
import { buildDeps } from "../../core/deps.js";
import { handleHealth, handleRequest } from "../../core/handler.js";
import { json } from "../../core/http.js";
import { createDurableBackend, type DoNamespace } from "./backend.js";
import { ChatSession } from "./session.js";

export { ChatSession };

export interface CfEnv extends Record<string, unknown> {
  CHAT_SESSION?: DoNamespace;
}

export interface CfContext {
  waitUntil(promise: Promise<unknown>): void;
}

function stringEnv(env: CfEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function handleCloudflare(request: Request, env: CfEnv, ctx: CfContext): Promise<Response> {
  let bot;
  try {
    const bots = loadBots(stringEnv(env));
    const pathname = new URL(request.url).pathname;
    const health = botsHealth(request.method, pathname, bots, env);
    if (health) return health;
    bot = selectBot(bots, pathname);
  } catch {
    return json(503, { ok: false, error: "bot_configuration_invalid" });
  }
  if (!bot) return json(404, { ok: false, error: "not_found" });
  const record = bot.env;
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  if (!env.CHAT_SESSION) {
    const deps = buildDeps({ env: record, typingMode: "once", waitUntil });
    const url = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/healthz" || url.pathname.endsWith("/healthz"))) {
      return handleHealth(deps);
    }
    return json(503, { ok: false, error: "durable_object_not_configured" });
  }
  const backend = createDurableBackend(env.CHAT_SESSION, bot.id);
  const deps = buildDeps({
    env: record,
    store: backend.store,
    typing: backend.typing,
    waitUntil,
  });
  return handleRequest(request, deps);
}

const worker = {
  fetch(request: Request, env: CfEnv, ctx: CfContext): Promise<Response> {
    return handleCloudflare(request, env, ctx);
  },
};

export default worker;
