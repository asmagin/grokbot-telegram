import { json } from "./http.js";
import { configStatus, fatalConfigProblems, isPlausibleBotToken, loadConfig, type EnvSource } from "./config.js";

export interface BotDefinition {
  /** null preserves the legacy routes and storage namespace. */
  id: string | null;
  env: Record<string, string | undefined>;
}

const PRIVATE_SETTINGS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TELEGRAM_BOT_ID",
  "REPLY_TOKEN_SECRET", "OUTBOUND_API_KEY", "ALLOWLIST_USER_IDS", "ALLOWLIST_CHAT_IDS",
  "GROK_WEBHOOK_URL", "GROK_WEBHOOK_SENDER_KEY",
];

/** Errors deliberately contain no JSON values or parser diagnostics (which may contain secrets). */
export function loadBots(source: EnvSource): BotDefinition[] {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === "string") env[key] = value;
  if (!env.TELEGRAM_BOTS?.trim()) return [{ id: null, env }];
  const invalid = () => new Error("invalid_TELEGRAM_BOTS");
  let raw: unknown;
  try { raw = JSON.parse(env.TELEGRAM_BOTS); } catch { throw invalid(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) throw invalid();
  const bots: BotDefinition[] = [];
  const unique = new Map<string, Set<string>>();
  for (const [id, settings] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || !settings || typeof settings !== "object" || Array.isArray(settings)) throw invalid();
    const selected = { ...env };
    delete selected.TELEGRAM_BOTS;
    for (const key of PRIVATE_SETTINGS) delete selected[key];
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== "string" || key === "TELEGRAM_BOTS" || key === "PATH_PREFIX" || key === "PUBLIC_BASE_URL") throw invalid();
      selected[key] = value;
    }
    selected.BRIDGE_BOT_NAME = id;
    selected.PATH_PREFIX = `${loadConfig(env).pathPrefix}/bots/${id}`;
    const config = loadConfig(selected);
    if (fatalConfigProblems(config).length || config.problems.length || !isPlausibleBotToken(config.telegramBotToken) || !config.telegramBotUsername) throw invalid();
    // Sharing these credentials would let one bot authenticate as another.
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "REPLY_TOKEN_SECRET", "OUTBOUND_API_KEY"]) {
      const value = selected[key]?.trim();
      if (!value) continue;
      const seen = unique.get(key) ?? new Set<string>();
      if (seen.has(value)) throw invalid();
      seen.add(value);
      unique.set(key, seen);
    }
    bots.push({ id, env: selected });
  }
  return bots;
}

export function selectBot(bots: BotDefinition[], pathname: string): BotDefinition | undefined {
  return bots.find((bot) => {
    const prefix = loadConfig(bot.env).pathPrefix;
    return bot.id === null || pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

/** Deployment probe; per-bot /healthz retains the detailed single-bot response. */
export function botsHealth(method: string, pathname: string, bots: BotDefinition[], env: EnvSource): Response | null {
  if (bots[0]?.id === null || (method !== "GET" && method !== "HEAD")) return null;
  if (pathname !== `${loadConfig(env).pathPrefix}/healthz`) return null;
  const statuses = Object.fromEntries(bots.map((bot) => {
    const config = loadConfig(bot.env);
    return [bot.id!, Object.values(configStatus(config)).every(Boolean) && !config.problems.length];
  }));
  const response = json(200, { ok: true, service: "grokbot-telegram", ready: Object.values(statuses).every(Boolean), bots: statuses });
  return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
