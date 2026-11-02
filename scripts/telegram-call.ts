import { loadBots } from "../src/core/bots.js";

export const selectedEnv = (() => {
  try {
    const bots = loadBots(process.env);
    const index = process.argv.indexOf("--bot");
    const id = index >= 0 ? process.argv[index + 1] : null;
    const bot = bots.find((entry) => entry.id === id);
    if (!bot) throw new Error("selection_required");
    return bot.env;
  } catch {
    console.error("Invalid bot configuration or selection. Use --bot <name> in multi-bot mode.");
    process.exit(1);
  }
})();

import { telegramMethodUrl } from "../src/core/telegram.js";

export function requireEnv(name: string): string {
  const value = selectedEnv[name]?.trim() ?? "";
  if (!value) {
    console.error(JSON.stringify({ ok: false, error: "missing_env", name }));
    process.exit(1);
  }
  return value;
}

export async function telegramCall(method: string, body: unknown): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const url = telegramMethodUrl(token, method);
  if (!url) {
    console.error(JSON.stringify({ ok: false, error: "bot_token_invalid" }));
    process.exit(1);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Never print the error object: some runtimes include the request URL, which holds the token.
    console.error(JSON.stringify({ ok: false, method, error: err instanceof Error ? err.name : "error" }));
    process.exit(1);
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = payload && typeof payload === "object" ? payload as { ok?: boolean; description?: string; result?: unknown } : {};
  if (!response.ok || record.ok !== true) {
    console.error(JSON.stringify({
      ok: false,
      method,
      status: response.status,
      description: record.description ?? "telegram_error",
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, method, result: record.result ?? null }));
}
