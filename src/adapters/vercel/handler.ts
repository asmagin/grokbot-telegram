import { botsHealth, loadBots, selectBot } from "../../core/bots.js";
import { json } from "../../core/http.js";
import { waitUntil } from "@vercel/functions";
import { buildDeps, type AppDeps } from "../../core/deps.js";
import { handleRequest } from "../../core/handler.js";
import { MemoryStore, type Store } from "../../core/store.js";
import { createTelegramClient, type TelegramClient } from "../../core/telegram.js";
import { createLogger } from "../../core/log.js";
import { createStoreTyping, telegramEffects, type TypingController } from "../../core/typing.js";

interface Shared {
  bots?: Map<string, Shared>;
  store?: Store;
  typing?: TypingController;
}

const shared: Shared = {};

/** Test hook. Production instances keep the store for the life of the isolate. */
export function resetVercelShared(): void {
  shared.bots = undefined;
  shared.store = undefined;
  shared.typing = undefined;
}

function vercelWaitUntil(promise: Promise<unknown>): void {
  try {
    waitUntil(promise);
  } catch {
    promise.catch(() => undefined);
  }
}

export function createVercelDeps(
  env: Record<string, string | undefined>,
  state: Shared = shared,
  fetchImpl?: typeof fetch,
): AppDeps {
  if (!state.store) {
    state.store = new MemoryStore();
  }
  if (!state.typing) {
    const store = state.store;
    const telegram: TelegramClient = createTelegramClient({
      token: env.TELEGRAM_BOT_TOKEN ?? "",
      fetchImpl,
    });
    // No timer survives the response here: each start, interim send, or heartbeat pulses typing once.
    state.typing = createStoreTyping({
      store,
      mode: "once",
      now: () => Date.now(),
      effects: telegramEffects(telegram, createLogger([env.TELEGRAM_BOT_TOKEN ?? ""])),
    });
  }
  return buildDeps({
    env,
    store: state.store,
    typing: state.typing,
    typingMode: "once",
    fetchImpl,
    waitUntil: vercelWaitUntil,
  });
}

/**
 * vercel.json rewrites every route to this one function, with the public path in `?path=`.
 * One function means the webhook and the later `/send` or `/typing/*` calls share one store.
 */
export async function vercelFetch(
  request: Request,
  env: Record<string, string | undefined> = envRecord(process.env),
  state: Shared = shared,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.searchParams.get("path") ?? url.pathname;
  try {
    const bots = loadBots(env);
    const health = botsHealth(request.method, url.pathname, bots, env);
    if (health) return health;
    const bot = selectBot(bots, url.pathname);
    if (!bot) return json(404, { ok: false, error: "not_found" });
    let selected = state;
    if (bot.id !== null) {
      state.bots ??= new Map();
      selected = state.bots.get(bot.id) ?? {};
      state.bots.set(bot.id, selected);
    }
    return handleRequest(new Request(url, request), createVercelDeps(bot.env, selected, fetchImpl));
  } catch {
    return json(503, { ok: false, error: "bot_configuration_invalid" });
  }
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) out[key] = value;
  return out;
}
